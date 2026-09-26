import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { CallCopilotUploadService } from '../call-copilot/call-copilot-upload.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { NotificationsService } from '../notifications/notifications.service';
import { EMPTY_RESPONSE_XML, recordAndDialXml, speakAndHangupXml } from './plivo-xml';
import { isValidPlivoSignature } from './plivo-signature';
import { PlivoService } from './plivo.service';
import { PlivoCall, PlivoCallDocument, PlivoCallStatus } from './schemas/plivo-call.schema';
import { PlivoLine, PlivoLineDocument } from './schemas/plivo-line.schema';

type WebhookBody = Record<string, unknown>;

export interface WebhookRequest {
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: WebhookBody;
}

// What the controller sends back: a status, and XML when Plivo expects it.
export type WebhookResult = { status: 200; xml: string } | { status: 400 | 403 | 404 };

const DUPLICATE_KEY_ERROR = 11000;
const MAX_RECORDING_BYTES = 300 * 1024 * 1024; // same ceiling as a browser upload
// The recording callback fires when the file is ready, but the media host can
// lag a moment behind — a few short retries beat failing a whole call's import.
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 5_000;

const DIAL_STATUS_TO_CALL_STATUS: Record<string, PlivoCallStatus> = {
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  timeout: 'no_answer',
  cancel: 'cancelled',
  failed: 'failed',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Plivo calls these endpoints, not a signed-in user — so nothing here is trusted
// until the request's signature checks out against the Auth Token of the
// organization the call belongs to. That organization is found from data we
// created (the call id we embedded in the URLs, or the Plivo number a caller
// dialed), never from anything the request claims about itself.
@Injectable()
export class PlivoWebhooksService {
  private readonly logger = new Logger(PlivoWebhooksService.name);
  // A field (not just the constant) so tests can run the retry path without waiting.
  private retryDelayMs = DOWNLOAD_RETRY_DELAY_MS;

  constructor(
    @InjectModel(PlivoCall.name) private callModel: Model<PlivoCallDocument>,
    @InjectModel(PlivoLine.name) private lineModel: Model<PlivoLineDocument>,
    private plivo: PlivoService,
    private http: HttpService,
    private uploads: CallCopilotUploadService,
    private notifications: NotificationsService,
  ) {}

  private async isAuthentic(organizationId: string, req: WebhookRequest): Promise<boolean> {
    const base = this.plivo.publicBaseUrl;
    if (!base) return false; // can't reconstruct the URL Plivo signed
    const creds = await this.plivo.getCredentials(organizationId);
    if (!creds) return false;
    const params = req.body ?? {};
    const nonce = header(req.headers['x-plivo-signature-v3-nonce']);
    const requestUrl = `${base}${req.originalUrl}`;
    // Plivo sends one signature made with the (sub)account's token and, for a
    // subaccount, another made with the main account's.
    return [header(req.headers['x-plivo-signature-v3']), header(req.headers['x-plivo-signature-ma-v3'])].some((signatureHeader) =>
      isValidPlivoSignature({ method: 'POST', requestUrl, params, nonce, signatureHeader, authToken: creds.authToken }),
    );
  }

  private async findCall(callId: string | undefined): Promise<PlivoCallDocument | null> {
    return callId && isValidObjectId(callId) ? this.callModel.findById(callId).exec() : null;
  }

  // ---- Answer -----------------------------------------------------------------

  /**
   * Plivo asks what to do with a call that was just answered. Two cases:
   *  - our own click-to-call (a `callId` we put in the URL): the agent picked
   *    up, so record the call and dial the customer;
   *  - an inbound call to one of our Plivo numbers (no callId): find whose line
   *    it is, log the call, and forward it to their phone, recorded.
   */
  async answer(req: WebhookRequest, callIdParam: string | undefined): Promise<WebhookResult> {
    const body = req.body ?? {};
    const callUuid = text(body.CallUUID);

    if (callIdParam) {
      const call = await this.findCall(callIdParam);
      if (!call) return { status: 404 };
      if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };
      await this.callModel.updateOne({ _id: call._id }, { $set: { status: 'in_progress', ...(callUuid ? { callUuid } : {}) } }).exec();
      return { status: 200, xml: this.dialXml(call._id.toString(), call.plivoNumber, call.customerNumber) };
    }

    const dialed = this.plivo.normalize(text(body.To));
    const line = dialed ? await this.lineModel.findOne({ plivoNumber: dialed, active: true }).exec() : null;
    // Not one of our numbers: nobody's Auth Token to verify against, and nothing
    // to do — a polite message rather than an error or an open door.
    if (!line) return { status: 200, xml: speakAndHangupXml('This number is not set up to take calls yet.') };
    if (!(await this.isAuthentic(line.organizationId, req))) return { status: 403 };
    if (!callUuid) return { status: 400 };

    // Plivo retries an unanswered webhook — keyed on the call's own id so a
    // retry finds the same record instead of logging the call twice.
    const call = await this.callModel
      .findOneAndUpdate(
        { organizationId: line.organizationId, callUuid },
        {
          // organizationId and callUuid come from the filter above.
          $setOnInsert: {
            userId: line.userId,
            direction: 'inbound',
            plivoNumber: line.plivoNumber,
            agentPhone: line.agentPhone,
            customerNumber: this.plivo.normalize(text(body.From)) ?? (text(body.From).replace(/\D/g, '') || 'unknown'),
            languageCode: line.languageCode,
          },
          $set: { status: 'in_progress' },
        },
        { upsert: true, new: true },
      )
      .exec();
    return { status: 200, xml: this.dialXml(call._id.toString(), line.plivoNumber, line.agentPhone) };
  }

  private dialXml(callId: string, callerId: string, destination: string): string {
    const base = this.plivo.publicBaseUrl;
    return recordAndDialXml({
      recordingCallbackUrl: `${base}/plivo/webhooks/recording?callId=${callId}`,
      dialActionUrl: `${base}/plivo/webhooks/hangup?callId=${callId}`,
      callerId,
      destination,
    });
  }

  // ---- Recording ready -------------------------------------------------------

  /** Plivo says a recording is ready. Claims it atomically (so a redelivered
   * webhook can never import a call twice), acknowledges immediately, and
   * imports in the background — Plivo should not be kept waiting through a
   * download, a transcription and an AI summary. */
  async recordingReady(req: WebhookRequest, callIdParam: string | undefined): Promise<WebhookResult> {
    const call = await this.findCall(callIdParam);
    if (!call) return { status: 404 };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };

    const body = req.body ?? {};
    const recordingId = text(body.RecordingID);
    const recordUrl = text(body.RecordUrl);
    if (!recordingId || !recordUrl) return { status: 400 };
    const durationSeconds = Number(text(body.RecordingDuration));

    let claimed: PlivoCallDocument | null;
    try {
      claimed = await this.callModel
        .findOneAndUpdate(
          { _id: call._id, recordingId: { $exists: false } },
          {
            $set: {
              recordingId,
              recordingUrl: recordUrl,
              importStatus: 'pending',
              ...(Number.isFinite(durationSeconds) ? { recordingDurationSeconds: durationSeconds } : {}),
            },
          },
          { new: true },
        )
        .exec();
    } catch (err) {
      // The same recording id on another call: a duplicate delivery, not a new call.
      if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR) return { status: 200, xml: EMPTY_RESPONSE_XML };
      throw err;
    }
    if (claimed) {
      void this.importRecording(claimed).catch((err) => this.logger.error(`Import of Plivo call ${claimed!._id.toString()} crashed: ${(err as Error).message}`));
    }
    return { status: 200, xml: EMPTY_RESPONSE_XML };
  }

  // ---- Call ended ------------------------------------------------------------

  /** How the call ended — both from the Dial's `action` URL (DialStatus) and
   * from the Plivo Application's Hangup URL (CallStatus), which carry the same
   * outcome under different names. */
  async hangup(req: WebhookRequest, callIdParam: string | undefined): Promise<WebhookResult> {
    const body = req.body ?? {};
    const callUuid = text(body.CallUUID);
    const call = callIdParam ? await this.findCall(callIdParam) : callUuid ? await this.callModel.findOne({ callUuid }).exec() : null;
    // A call we don't know (or no way to verify it): acknowledge and move on.
    if (!call) return { status: 200, xml: EMPTY_RESPONSE_XML };
    if (!(await this.isAuthentic(call.organizationId, req))) return { status: 403 };

    const outcome = DIAL_STATUS_TO_CALL_STATUS[text(body.DialStatus || body.CallStatus).toLowerCase()];
    const duration = Number(text(body.Duration || body.BillDuration));
    const set: Record<string, unknown> = {};
    if (outcome) set.status = outcome;
    if (Number.isFinite(duration) && duration > 0) set.durationSeconds = duration;
    if (outcome && outcome !== 'completed') set.failureReason = `Call ${outcome.replace('_', ' ')}.`;
    if (Object.keys(set).length) await this.callModel.updateOne({ _id: call._id }, { $set: set }).exec();
    return { status: 200, xml: EMPTY_RESPONSE_XML };
  }

  // ---- Import -----------------------------------------------------------------

  /** Downloads the recording and hands it to Call Copilot — the same pipeline as
   * "Upload a Recording": transcript, summary, AI Coach. Also the retry path for
   * an import that failed (e.g. out of credits): safe to call again. */
  async importRecording(call: PlivoCallDocument): Promise<void> {
    await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'pending' }, $unset: { importError: '' } }).exec();
    try {
      if (!call.recordingUrl || !call.recordingId) throw new Error('This call has no recording to import.');
      const audio = await this.downloadRecording(call.organizationId, call.recordingUrl);
      const session = await this.uploads.startSessionFromRecording(call.organizationId, call.userId, audio, `plivo-${call.recordingId}.mp3`, {
        dealId: call.dealId,
        languageCode: call.languageCode,
      });
      await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'imported', sessionId: session._id.toString() } }).exec();
      await this.notify(call, 'Call recording ready', `Your call with ${call.customerNumber} is being transcribed. The summary and AI Coach report will appear in Call Library shortly.`);
    } catch (err) {
      const message = (err as Error).message || 'The recording could not be imported.';
      this.logger.warn(`Plivo call ${call._id.toString()} import failed: ${message}`);
      await this.callModel.updateOne({ _id: call._id }, { $set: { importStatus: 'failed', importError: message.slice(0, 300) } }).exec();
      await this.notify(call, 'Call recording could not be processed', `${message} You can retry from Settings → Calling.`);
    }
  }

  private async downloadRecording(organizationId: string, recordUrl: string): Promise<Buffer> {
    // The URL arrives in a signed webhook, but it is still a URL this server is
    // about to fetch — refuse anything that points inside the network.
    await assertPublicHttpUrl(recordUrl);
    const isPlivoHost = /(^|\.)plivo\.com$/i.test(new URL(recordUrl).hostname);
    // Plivo's own hosts may want the account credentials; nobody else ever gets them.
    const creds = isPlivoHost ? await this.plivo.getCredentials(organizationId) : null;

    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const { data } = await firstValueFrom(
          this.http.get<ArrayBuffer>(recordUrl, {
            responseType: 'arraybuffer',
            timeout: 120_000,
            maxContentLength: MAX_RECORDING_BYTES,
            ...(creds ? { auth: { username: creds.authId, password: creds.authToken } } : {}),
          }),
        );
        return Buffer.from(data);
      } catch (err) {
        lastError = err;
        if (attempt < DOWNLOAD_ATTEMPTS) await sleep(this.retryDelayMs);
      }
    }
    const status = (lastError as AxiosError).response?.status;
    throw new Error(`Could not download the recording from Plivo${status ? ` (HTTP ${status})` : ''}.`);
  }

  private notify(call: PlivoCallDocument, title: string, description: string): Promise<unknown> {
    return this.notifications
      .create(call.userId, { kind: 'system', title, description, source: 'call-copilot' }, call.organizationId)
      .catch((err) => this.logger.warn(`Plivo call notification failed: ${(err as Error).message}`));
  }
}
