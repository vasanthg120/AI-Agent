import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PlivoWebhooksService } from '../plivo/plivo-webhooks.service';
import { PlivoService } from '../plivo/plivo.service';
import { PlivoCallDocument } from '../plivo/schemas/plivo-call.schema';
import { TwilioCallDocument } from '../twilio/schemas/twilio-call.schema';
import { TwilioWebhooksService } from '../twilio/twilio-webhooks.service';
import { TwilioService } from '../twilio/twilio.service';
import { CallingProvider, chooseProvider } from './calling-routing';

// An import runs inside this process, so a restart mid-import leaves it marked
// "pending" for good; past this long without a change it may be retried.
const IMPORT_STUCK_AFTER_MS = 15 * 60_000;
const CALL_LOG_LIMIT = 30;

export interface CallView {
  id: string;
  provider: CallingProvider;
  direction: 'outbound' | 'inbound';
  customerNumber: string;
  // The Plivo / Twilio number the call went through.
  businessNumber: string;
  status: string;
  failureReason?: string;
  durationSeconds?: number;
  importStatus: string;
  importError?: string;
  sessionId?: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderLineSummary {
  businessNumber: string;
  agentPhone: string;
}

function toView(provider: CallingProvider, call: PlivoCallDocument | TwilioCallDocument): CallView {
  const businessNumber = provider === 'plivo' ? (call as PlivoCallDocument).plivoNumber : (call as TwilioCallDocument).twilioNumber;
  return {
    id: call._id.toString(),
    provider,
    direction: call.direction,
    customerNumber: call.customerNumber,
    businessNumber,
    status: call.status,
    failureReason: call.failureReason,
    durationSeconds: call.durationSeconds ?? call.recordingDurationSeconds,
    importStatus: call.importStatus,
    importError: call.importError,
    sessionId: call.sessionId,
    userId: call.userId,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

// One front door for phone calls, whichever carrier carries them: what the
// signed-in person can call with, placing a call (routed by destination), and a
// single call log. Setup stays per provider (/plivo, /twilio).
@Injectable()
export class CallingService {
  constructor(
    private plivo: PlivoService,
    private plivoWebhooks: PlivoWebhooksService,
    private twilio: TwilioService,
    private twilioWebhooks: TwilioWebhooksService,
  ) {}

  get domesticCountryCode(): string {
    return this.plivo.defaultCountryCode;
  }

  async overview(user: JwtPayload, canManage: boolean) {
    const org = user.organizationId;
    const [plivoStatus, twilioStatus, plivoLines, twilioLines] = await Promise.all([
      this.plivo.status(org),
      this.twilio.status(org),
      this.plivo.listLines(org, user.sub),
      this.twilio.listLines(org, user.sub),
    ]);
    const plivoLine = plivoLines.find((l) => l.active);
    const twilioLine = twilioLines.find((l) => l.active);
    const plivoReady = plivoStatus.connected && this.plivo.publicBaseUrl !== '' && !!plivoLine;
    const twilioReady = twilioStatus.connected && this.twilio.publicBaseUrl !== '' && !!twilioLine;
    return {
      canManage,
      domesticCountryCode: this.domesticCountryCode,
      canCall: plivoReady || twilioReady,
      providers: {
        plivo: {
          connected: plivoStatus.connected,
          ready: plivoReady,
          line: plivoLine ? ({ businessNumber: plivoLine.plivoNumber, agentPhone: plivoLine.agentPhone } as ProviderLineSummary) : null,
        },
        twilio: {
          connected: twilioStatus.connected,
          ready: twilioReady,
          line: twilioLine ? ({ businessNumber: twilioLine.twilioNumber, agentPhone: twilioLine.agentPhone } as ProviderLineSummary) : null,
        },
      },
    };
  }

  private async availableProviders(user: JwtPayload): Promise<CallingProvider[]> {
    const org = user.organizationId;
    const [plivoCreds, twilioCreds, plivoLines, twilioLine] = await Promise.all([
      this.plivo.getCredentials(org),
      this.twilio.getCredentials(org),
      this.plivo.listLines(org, user.sub),
      this.twilio.findActiveLineFor(org, user.sub),
    ]);
    const available: CallingProvider[] = [];
    if (plivoCreds && this.plivo.publicBaseUrl && plivoLines.some((l) => l.active)) available.push('plivo');
    if (twilioCreds && this.twilio.publicBaseUrl && twilioLine) available.push('twilio');
    return available;
  }

  async startCall(user: JwtPayload, rawNumber: string, dealId?: string, requested?: CallingProvider): Promise<CallView> {
    const customerNumber = this.twilio.normalize(rawNumber);
    if (!customerNumber) throw new BadRequestException('Enter the customer number with its country code, e.g. +44 7700 900123.');

    const available = await this.availableProviders(user);
    if (available.length === 0) {
      throw new BadRequestException('You do not have a phone line yet. Ask an administrator to link a Plivo or Twilio number to you in Settings → Calling.');
    }
    const provider = chooseProvider(customerNumber, available, this.domesticCountryCode, requested);
    if (!provider) throw new BadRequestException(`You do not have a ${requested === 'twilio' ? 'Twilio' : 'Plivo'} line. Choose another route.`);

    // One call being set up at a time across both carriers — a second click would
    // ring the agent's phone twice and bill two calls.
    const [plivoBusy, twilioBusy] = await Promise.all([this.plivo.hasCallInProgress(user.sub), this.twilio.hasCallInProgress(user.sub)]);
    if (plivoBusy || twilioBusy) throw new ConflictException('A call is already being set up. Answer your phone, or wait a minute before trying again.');

    if (provider === 'plivo') {
      return toView('plivo', await this.plivo.startCall(user, { customerNumber, dealId }, true));
    }
    return toView('twilio', await this.twilio.startCall(user, customerNumber, dealId));
  }

  async listCalls(user: JwtPayload, orgWide: boolean): Promise<CallView[]> {
    const [plivoCalls, twilioCalls] = await Promise.all([this.plivo.listCalls(user, orgWide), this.twilio.listCalls(user, orgWide)]);
    return [...plivoCalls.map((c) => toView('plivo', c)), ...twilioCalls.map((c) => toView('twilio', c))]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, CALL_LOG_LIMIT);
  }

  async retryImport(user: JwtPayload, provider: CallingProvider, id: string, orgWide: boolean): Promise<CallView> {
    const call = provider === 'plivo' ? await this.plivo.getCallForUser(user, id, orgWide) : await this.twilio.getCallForUser(user, id, orgWide);
    const stuck = call.importStatus === 'pending' && Date.now() - call.updatedAt.getTime() > IMPORT_STUCK_AFTER_MS;
    if (call.importStatus === 'failed' || stuck) {
      if (provider === 'plivo') await this.plivoWebhooks.importRecording(call as PlivoCallDocument);
      else await this.twilioWebhooks.importRecording(call as TwilioCallDocument);
    }
    const fresh = provider === 'plivo' ? await this.plivo.getCallForUser(user, id, orgWide) : await this.twilio.getCallForUser(user, id, orgWide);
    return toView(provider, fresh);
  }
}
