import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { CallCopilotUploadService } from '../call-copilot/call-copilot-upload.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { NotificationsService } from '../notifications/notifications.service';
import { isValidTwilioSignature } from './twilio-signature';
import { EMPTY_TWIML, recordAndDialTwiml, sayAndHangupTwiml, sayTwiml } from './twilio-twiml';
import { TwilioService } from './twilio.service';
import { TwilioCall, TwilioCallDocument, TwilioCallStatus } from './schemas/twilio-call.schema';
import { TwilioLine, TwilioLineDocument } from './schemas/twilio-line.schema';

type WebhookBody = Record<string, unknown>;

export interface TwilioWebhookRequest {
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: WebhookBody;
}

export type TwilioWebhookResult = { status: 200; xml: string } | { status: 400 | 403 | 404 };

const DUPLICATE_KEY_ERROR = 11000;
const MAX_RECORDING_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 5_000;

export const RECORDING_NOTICE = 'This call is recorded for quality and training purposes.';
const AGENT_GREETING = 'Connecting you to your customer.';

// <Dial> action (customer leg) and call StatusCallback (agent/caller leg) use
// slightly different words for the same outcomes.
const DIAL_STATUS: Record<string, TwilioCallStatus> = {
  completed: 'completed',
  answered: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};
const CALL_STATUS: Record<string, TwilioCallStatus> = {
  queued: 'initiated',
  ringing: 'initiated',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Twilio calls these endpoints, not a signed-in user — nothing is trusted until
// the request's X-Twilio-Signature checks out against the Auth Token of the
// organization the call belongs to. That organization is found from data we
// created (the call id embedded in the URLs, or the Twilio number dialed).
@Injectable()
export class TwilioWebhooksService {
  private readonly logger = new Logger(TwilioWebhooksService.name);
  private retryDelayMs = DOWNLOAD_RETRY_DELAY_MS;

  constructor(
    @InjectModel(TwilioCall.name) private callModel: Model<TwilioCallDocument>,
    @InjectModel(TwilioLine.name) private lineModel: Model<TwilioLineDocument>,
    private twilio: TwilioService,
    private http: HttpService,
    private uploads: CallCopilotUploadService,
    private notifications: NotificationsService,
  ) {}

  private async isAuthentic(organizationId: string, req: TwilioWebhookRequest): Promise<boolean> {
    const base = this.twilio.publicBaseUrl;
    if (!base) return false;
    const creds = await this.twilio.getCredentials(organizationId);
    if (!creds) return false;
    const params = req.body ?? {};
    // Defence in depth: a validly signed request is still refused if it is about
    // a different Twilio account than the one this organization connected.
    const accountSid = text(params.AccountSid);
    if (accountSid && accountSid !== creds.accountSid) return false;
    return isValidTwilioSignature({
      authToken: creds.authToken,
      url: `${base}${req.originalUrl}`,
      params,
      signatureHeader: header(req.headers['x-twilio-signature']),
    });
  }

  private findCall(callId: string | undefined): Promise<TwilioCallDocument | null> {
    return callId && isValidObjectId(callId) ? this.callModel.findById(callId).exec() : Promise.resolve(null);
  }

  private urls(callId: string) {
    const base = this.twilio.publicBaseUrl;
    return {
      recording: `${base}/twilio/webhooks/recording?callId=${callId}`,
      dialStatus: `${base}/twilio/webhooks/dial-status?callId=${callId}`,
      announce: `${base}/twilio/webhooks/announce?callId=${callId}`,
    };
  }

  // ---- Voice: a call was answered (outbound) or arrived (inbound) -------------

  async voice(req: TwilioWebhookRequest, callIdParam: string | undefined): Promise<TwilioWebhookResult> {
    const body = req.body ?? {};
    const callSid = text(body.CallSid);

    if (callIdParam) {
      // Our own click-to-call: the agent picked up, so record and dial the customer.
      const call = await this.findCall(callIdParam);
      if (!call) return { status: 404 };
      if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };
      await this.callModel.updateOne({ _id: call._id }, { $set: { status: 'in_progress', ...(callSid ? { callSid } : {}) } }).exec();
      const line = await this.lineModel.findOne({ twilioNumber: call.twilioNumber }).exec();
      const urls = this.urls(call._id.toString());
      return {
        status: 200,
        xml: recordAndDialTwiml({
          callerId: `+${call.twilioNumber}`,
          destination: `+${call.customerNumber}`,
          recordingCallbackUrl: urls.recording,
          actionUrl: urls.dialStatus,
          announceUrl: line?.announceRecording === false ? undefined : urls.announce,
          greeting: AGENT_GREETING,
        }),
      };
    }

    // A customer dialed one of our Twilio numbers.
    const dialed = this.twilio.normalize(text(body.To));
    const line = dialed ? await this.lineModel.findOne({ twilioNumber: dialed, active: true }).exec() : null;
    if (!line) return { status: 200, xml: sayAndHangupTwiml('This number is not set up to take calls yet.') };
    if (!(await this.isAuthentic(line.organizationId, req))) return { status: 403 };
    if (!callSid) return { status: 400 };

    // Twilio can retry a slow webhook — keyed on the call's own id so a retry
    // finds the same record instead of logging the call twice.
    const from = text(body.From);
    const call = await this.callModel
      .findOneAndUpdate(
        { organizationId: line.organizationId, callSid },
        {
          $setOnInsert: {
            userId: line.userId,
            direction: 'inbound',
            twilioNumber: line.twilioNumber,
            agentPhone: line.agentPhone,
            customerNumber: this.twilio.normalize(from) ?? (from.replace(/\D/g, '') || 'unknown'),
            languageCode: line.languageCode,
          },
          $set: { status: 'in_progress' },
        },
        { upsert: true, new: true },
      )
      .exec();
    const urls = this.urls(call._id.toString());
    return {
      status: 200,
      xml: recordAndDialTwiml({
        callerId: `+${line.twilioNumber}`,
        destination: `+${line.agentPhone}`,
        recordingCallbackUrl: urls.recording,
        actionUrl: urls.dialStatus,
        // The caller hears the notice before being put through to the agent.
        greeting: line.announceRecording === false ? undefined : RECORDING_NOTICE,
      }),
    };
  }

  /** Played to the customer the moment they pick up an outbound call. */
  async announce(req: TwilioWebhookRequest, callIdParam: string | undefined): Promise<TwilioWebhookResult> {
    const call = await this.findCall(callIdParam);
    if (!call) return { status: 404 };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };
    return { status: 200, xml: sayTwiml(RECORDING_NOTICE) };
  }

  // ---- Outcome of the <Dial> (the customer leg) -------------------------------

  async dialStatus(req: TwilioWebhookRequest, callIdParam: string | undefined): Promise<TwilioWebhookResult> {
    const call = await this.findCall(callIdParam);
    if (!call) return { status: 200, xml: EMPTY_TWIML };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };
    const body = req.body ?? {};
    const outcome = DIAL_STATUS[text(body.DialCallStatus).toLowerCase()];
    const duration = Number(text(body.DialCallDuration));
    const set: Record<string, unknown> = { dialOutcomeKnown: true };
    if (outcome) set.status = outcome;
    if (Number.isFinite(duration) && duration > 0) set.durationSeconds = duration;
    if (outcome && outcome !== 'completed') {
      set.failureReason = call.direction === 'outbound' ? `The customer's phone: ${outcome.replace('_', ' ')}.` : `Your phone: ${outcome.replace('_', ' ')}.`;
    }
    await this.callModel.updateOne({ _id: call._id }, { $set: set }).exec();
    // Nothing more to do on the call: hang up.
    return { status: 200, xml: EMPTY_TWIML };
  }

  // ---- Call status (the agent's leg for click-to-call, the caller's for inbound)

  async callStatus(req: TwilioWebhookRequest, callIdParam: string | undefined): Promise<TwilioWebhookResult> {
    const body = req.body ?? {};
    const callSid = text(body.CallSid);
    const call = callIdParam ? await this.findCall(callIdParam) : callSid ? await this.callModel.findOne({ callSid }).exec() : null;
    if (!call) return { status: 200, xml: EMPTY_TWIML };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };

    const outcome = CALL_STATUS[text(body.CallStatus).toLowerCase()];
    if (!outcome) return { status: 200, xml: EMPTY_TWIML };
    const set: Record<string, unknown> = { status: outcome };
    if (outcome !== 'completed' && outcome !== 'in_progress' && outcome !== 'initiated') {
      set.failureReason =
        call.direction === 'outbound'
          ? outcome === 'no_answer'
            ? 'Your phone was not answered, so the customer was not called.'
            : `Your phone: ${outcome.replace('_', ' ')}.`
          : `Call ${outcome.replace('_', ' ')}.`;
    }
    const duration = Number(text(body.CallDuration));
    if (Number.isFinite(duration) && duration > 0 && !call.durationSeconds) set.durationSeconds = duration;
    // The customer leg's own outcome (no answer, busy…) is the more useful one —
    // never overwritten by the agent leg simply ending.
    await this.callModel.updateOne({ _id: call._id, dialOutcomeKnown: { $ne: true } }, { $set: set }).exec();
    return { status: 200, xml: EMPTY_TWIML };
  }

  // ---- Recording ready ---------------------------------------------------------

  async recordingReady(req: TwilioWebhookRequest, callIdParam: string | undefined): Promise<TwilioWebhookResult> {
    const call = await this.findCall(callIdParam);
    if (!call) return { status: 404 };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };

    const body = req.body ?? {};
    const recordingSid = text(body.RecordingSid);
    const recordingUrl = text(body.RecordingUrl);
    const recordingStatus = text(body.RecordingStatus).toLowerCase();
    if (!recordingSid) return { status: 400 };
    if (recordingStatus && recordingStatus !== 'completed') {
      await this.callModel
        .updateOne({ _id: call._id, importStatus: 'none' }, { $set: { importStatus: 'failed', importError: 'Twilio could not record this call.' } })
        .exec();
      return { status: 200, xml: EMPTY_TWIML };
    }
    if (!recordingUrl) return { status: 400 };
    const durationSeconds = Number(text(body.RecordingDuration));

    let claimed: TwilioCallDocument | null;
    try {
      claimed = await this.callModel
        .findOneAndUpdate(
          { _id: call._id, recordingSid: { $exists: false } },
          {
            $set: {
              recordingSid,
              recordingUrl,
              importStatus: 'pending',
              ...(Number.isFinite(durationSeconds) ? { recordingDurationSeconds: durationSeconds } : {}),
            },
          },
          { new: true },
        )
        .exec();
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR) return { status: 200, xml: EMPTY_TWIML };
      throw err;
    }
    if (claimed) {
      void this.importRecording(claimed).catch((err) =>
        this.logger.error(`Import of Twilio call ${claimed!._id.toString()} crashed: ${(err as Error).message}`),
      );
    }
    return { status: 200, xml: EMPTY_TWIML };
  }

  // ---- Import -----------------------------------------------------------------

  /** Downloads the recording and hands it to Call Copilot — transcript, summary,
   * AI Coach — exactly like an uploaded file. Also the retry path. */
  async importRecording(call: TwilioCallDocument): Promise<void> {
    await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'pending' }, $unset: { importError: '' } }).exec();
    try {
      if (!call.recordingUrl || !call.recordingSid) throw new Error('This call has no recording to import.');
      const audio = await this.downloadRecording(call.organizationId, call.recordingUrl);
      const session = await this.uploads.startSessionFromRecording(call.organizationId, call.userId, audio, `twilio-${call.recordingSid}.mp3`, {
        dealId: call.dealId,
        languageCode: call.languageCode,
      });
      await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'imported', sessionId: session._id.toString() } }).exec();
      await this.notify(
        call,
        'Call recording ready',
        `Your call with +${call.customerNumber} is being transcribed. The summary and AI Coach report will appear in Call Library shortly.`,
      );
    } catch (err) {
      const message = (err as Error).message || 'The recording could not be imported.';
      this.logger.warn(`Twilio call ${call._id.toString()} import failed: ${message}`);
      await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'failed', importError: message.slice(0, 300) } }).exec();
      await this.notify(call, 'Call recording could not be processed', `${message} You can retry from Settings → Calling.`);
    }
  }

  private async downloadRecording(organizationId: string, recordingUrl: string): Promise<Buffer> {
    // Twilio's RecordingUrl has no extension; asking for .mp3 gets a compact file.
    const url = /\.(mp3|wav)$/i.test(new URL(recordingUrl).pathname) ? recordingUrl : `${recordingUrl}.mp3`;
    await assertPublicHttpUrl(url);
    const isTwilioHost = /(^|\.)twilio\.com$/i.test(new URL(url).hostname);
    // Twilio's own hosts get the account credentials; nobody else ever does.
    const creds = isTwilioHost ? await this.twilio.getCredentials(organizationId) : null;

    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const { data } = await firstValueFrom(
          this.http.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            timeout: 120_000,
            maxContentLength: MAX_RECORDING_BYTES,
            ...(creds ? { auth: { username: creds.accountSid, password: creds.authToken } } : {}),
          }),
        );
        return Buffer.from(data);
      } catch (err) {
        lastError = err;
        if (attempt < DOWNLOAD_ATTEMPTS) await sleep(this.retryDelayMs);
      }
    }
    const status = (lastError as AxiosError).response?.status;
    throw new Error(`Could not download the recording from Twilio${status ? ` (HTTP ${status})` : ''}.`);
  }

  private notify(call: TwilioCallDocument, title: string, description: string): Promise<unknown> {
    return this.notifications
      .create(call.userId, { kind: 'system', title, description, source: 'call-copilot' }, call.organizationId)
      .catch((err) => this.logger.warn(`Twilio call notification failed: ${(err as Error).message}`));
  }
}
