import { HttpService } from '@nestjs/axios';
import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CallCopilotUploadService } from '../call-copilot/call-copilot-upload.service';
import { CallSession, CallSessionDocument } from '../call-copilot/schemas/call-session.schema';
import { isPermissionManaged } from '../common/permissions/permission.decorator';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { CallableCustomer, CustomerDirectoryService } from '../customer-intelligence/customer-directory.service';
import { maskPhone } from '../plivo/plivo-phone';
import { PlivoWebhooksService } from '../plivo/plivo-webhooks.service';
import { PlivoService } from '../plivo/plivo.service';
import { PlivoCallDocument } from '../plivo/schemas/plivo-call.schema';
import { TwilioCallDocument } from '../twilio/schemas/twilio-call.schema';
import { TwilioWebhooksService } from '../twilio/twilio-webhooks.service';
import { TwilioService } from '../twilio/twilio.service';
import { CallOutcome, Reachability, ReportSummary, describeCall, describeReport, reachabilityOf, startRefusalCode } from './call-outcome';
import { CallingProvider, chooseProvider } from './calling-routing';
import { dialableProblem } from './dialable-number';

// An import runs inside this process, so a restart mid-import leaves it marked
// "pending" for good; past this long without a change it may be retried.
const IMPORT_STUCK_AFTER_MS = 15 * 60_000;
const CALL_LOG_LIMIT = 30;
// How long a reachability answer is trusted: a good one for a minute, a bad one
// only briefly, so calling comes back soon after the tunnel does.
const REACHABLE_TTL_MS = 60_000;
const UNREACHABLE_TTL_MS = 15_000;
const DUPLICATE_KEY_ERROR = 11000;
const NOT_CONFIGURED_WARN_EVERY_MS = 10 * 60_000;

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
  dealId?: string;
  // Who was called: as picked from Contacts, else the linked deal's name.
  customerName?: string;
  // When the two sides were connected (the Dialer's "In call" timer starts here).
  answeredAt?: Date;
  // Where the call stands, in plain words (calling/call-outcome.ts).
  outcome: CallOutcome;
  // Its Call Copilot report, once the recording has become a session.
  report?: ReportSummary;
}

export interface ProviderLineSummary {
  businessNumber: string;
  agentPhone: string;
}

export interface StartCallOptions {
  dealId?: string;
  provider?: CallingProvider;
  // One tap of the Dialer's call button: the same key again returns the same call.
  requestKey?: string;
  customerName?: string;
}

function toView(provider: CallingProvider, call: PlivoCallDocument | TwilioCallDocument, now: Date): CallView {
  const businessNumber = provider === 'plivo' ? (call as PlivoCallDocument).plivoNumber : (call as TwilioCallDocument).twilioNumber;
  // Older Plivo calls predate agentAnsweredAt; they show it by carrying the call
  // id our Answer webhook stored. Older Twilio calls say so in failureReason.
  const agentAnswered = call.agentAnsweredAt
    ? true
    : provider === 'plivo' && call.direction === 'outbound'
      ? !!(call as PlivoCallDocument).callUuid
      : undefined;
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
    dealId: call.dealId,
    customerName: call.customerName,
    answeredAt: call.answeredAt,
    outcome: describeCall(
      {
        provider,
        direction: call.direction,
        status: call.status,
        failureReason: call.failureReason,
        failureCode: call.failureCode,
        agentAnswered,
        answeredAt: call.answeredAt,
        createdAt: call.createdAt,
      },
      now,
    ),
  };
}

/** A refusal the Dialer can word by its `code` (the message stays for everyone else). */
function refusal(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, message, error: status === 409 ? 'Conflict' : 'Bad Request', code }, status);
}

function messageOf(err: HttpException): string {
  const body = err.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  return Array.isArray(message) ? message.join(' ') : String(message ?? err.message);
}

// Long digit runs in a carrier's message are phone numbers: never in the log whole.
const maskDigits = (text: string) => text.replace(/\d{6,}/g, (run) => maskPhone(run));

// One front door for phone calls, whichever carrier carries them: what the
// signed-in person can call with, placing a call (routed by destination), and a
// single call log. Setup stays per provider (/plivo, /twilio).
@Injectable()
export class CallingService implements OnModuleInit {
  private readonly logger = new Logger(CallingService.name);
  // One start at a time per person in this process, so the "already being set
  // up" check sees the first tap's call before a second tap can get past it.
  private readonly starting = new Map<string, Promise<unknown>>();
  private readonly reachabilityCache = new Map<string, { at: number; value: Reachability }>();
  private readonly probing = new Map<string, Promise<Reachability>>();
  private readonly notConfiguredWarnedAt = new Map<string, number>();

  constructor(
    private plivo: PlivoService,
    private plivoWebhooks: PlivoWebhooksService,
    private twilio: TwilioService,
    private twilioWebhooks: TwilioWebhooksService,
    private http: HttpService,
    private directory: CustomerDirectoryService,
    private uploads: CallCopilotUploadService,
    @InjectModel(CallSession.name) private sessionModel: Model<CallSessionDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
  ) {}

  get domesticCountryCode(): string {
    return this.plivo.defaultCountryCode;
  }

  /** Once at startup: whether the carriers have an address to call back on (never the address itself). */
  onModuleInit() {
    const describe = (base: string) => (!base ? 'missing' : /ngrok/i.test(base) ? 'set(ngrok)' : 'set');
    this.logger.log(`calling.config plivo_public_url=${describe(this.plivo.publicBaseUrl)} twilio_public_url=${describe(this.twilio.publicBaseUrl)}`);
    if (process.env.NODE_ENV === 'production' && /ngrok/i.test(`${this.plivo.publicBaseUrl} ${this.twilio.publicBaseUrl}`)) {
      this.logger.warn('calling.config a production server is calling back through an ngrok tunnel; set PLIVO_PUBLIC_BASE_URL to https://<domain>/api');
    }
  }

  /**
   * What the signed-in person can call with. A provider is `ready` only when it is
   * connected, the server has a public address for its callbacks, AND an active line
   * is linked to this person — so a line can be linked (`line` set) while `ready` is
   * still false. `publicUrlConfigured` says which part is missing.
   */
  async overview(user: JwtPayload, canManage: boolean, recheck = false) {
    const org = user.organizationId;
    const [plivoStatus, twilioStatus, plivoLines, twilioLines] = await Promise.all([
      this.plivo.status(org),
      this.twilio.status(org),
      this.plivo.listLines(org, user.sub),
      this.twilio.listLines(org, user.sub),
    ]);
    const plivoLine = plivoLines.find((l) => l.active);
    const twilioLine = twilioLines.find((l) => l.active);
    const plivoUrl = this.plivo.publicBaseUrl !== '';
    const twilioUrl = this.twilio.publicBaseUrl !== '';
    const plivoReady = plivoStatus.connected && plivoUrl && !!plivoLine;
    const twilioReady = twilioStatus.connected && twilioUrl && !!twilioLine;
    // Only worth asking for a provider someone could actually call through.
    const [plivoReach, twilioReach] = await Promise.all([
      plivoStatus.connected ? this.reachability(this.plivo.publicBaseUrl, recheck) : Promise.resolve<Reachability>('unknown'),
      twilioStatus.connected ? this.reachability(this.twilio.publicBaseUrl, recheck) : Promise.resolve<Reachability>('unknown'),
    ]);
    const canCall = plivoReady || twilioReady;

    this.logger.debug(
      `calling.status org=${org} user=${user.sub} can_call=${canCall} ` +
        `plivo(connected=${plivoStatus.connected} public_url=${plivoUrl} lines=${plivoLines.length} active=${plivoLines.filter((l) => l.active).length}) ` +
        `twilio(connected=${twilioStatus.connected} public_url=${twilioUrl} lines=${twilioLines.length} active=${twilioLines.filter((l) => l.active).length})`,
    );
    // A linked line that still can't call is the case people report as "linked, but it says no line".
    if (plivoStatus.connected && plivoLine && !plivoUrl) this.warnNotConfigured(org, user.sub, 'plivo', 'PLIVO_PUBLIC_BASE_URL');
    if (twilioStatus.connected && twilioLine && !twilioUrl) this.warnNotConfigured(org, user.sub, 'twilio', 'TWILIO_PUBLIC_BASE_URL');

    return {
      canManage,
      domesticCountryCode: this.domesticCountryCode,
      canCall,
      providers: {
        plivo: {
          connected: plivoStatus.connected,
          ready: plivoReady,
          publicUrlConfigured: plivoUrl,
          reachability: plivoReach,
          line: plivoLine ? ({ businessNumber: plivoLine.plivoNumber, agentPhone: plivoLine.agentPhone } as ProviderLineSummary) : null,
        },
        twilio: {
          connected: twilioStatus.connected,
          ready: twilioReady,
          publicUrlConfigured: twilioUrl,
          reachability: twilioReach,
          line: twilioLine ? ({ businessNumber: twilioLine.twilioNumber, agentPhone: twilioLine.agentPhone } as ProviderLineSummary) : null,
        },
      },
    };
  }

  // At most once per person and provider every ten minutes — the overview is read on every page focus.
  private warnNotConfigured(org: string, userId: string, provider: CallingProvider, envName: string) {
    const key = `${org}:${userId}:${provider}`;
    const last = this.notConfiguredWarnedAt.get(key) ?? 0;
    if (Date.now() - last < NOT_CONFIGURED_WARN_EVERY_MS) return;
    this.notConfiguredWarnedAt.set(key, Date.now());
    this.logger.warn(`calling.status.not_configured org=${org} user=${userId} provider=${provider} line=linked public_url=missing env=${envName}`);
  }

  // ---- can Plivo / Twilio reach us? ---------------------------------------------

  /** Whether the public address the carriers call back on answers as this backend.
   * Cached per address, and one probe at a time however many people ask. */
  async reachability(base: string, force = false): Promise<Reachability> {
    if (!base) return 'not_configured';
    const hit = this.reachabilityCache.get(base);
    const ttl = hit?.value === 'reachable' ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS;
    if (!force && hit && Date.now() - hit.at < ttl) return hit.value;
    const inFlight = this.probing.get(base);
    if (inFlight) return inFlight;
    const probe = this.probe(base).then((value) => {
      this.reachabilityCache.set(base, { at: Date.now(), value });
      if (value === 'unreachable') this.logger.warn(`calling.unreachable base=${base}`);
      return value;
    });
    this.probing.set(base, probe);
    try {
      return await probe;
    } finally {
      this.probing.delete(base);
    }
  }

  private async probe(base: string): Promise<Reachability> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${base}/health`, {
          timeout: 5_000,
          validateStatus: () => true,
          // A plain client, so a tunnel never answers with a browser warning page.
          headers: { 'User-Agent': 'HaiVE-calling-check/1.0', 'ngrok-skip-browser-warning': '1' },
        }),
      );
      return reachabilityOf({ status: res.status, headers: res.headers as Record<string, unknown>, body: res.data });
    } catch (err) {
      return reachabilityOf({ errorCode: (err as AxiosError).code ?? 'UNKNOWN' });
    }
  }

  // ---- placing a call ------------------------------------------------------------

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

  async startCall(user: JwtPayload, rawNumber: string, options: StartCallOptions = {}): Promise<CallView> {
    const previous = this.starting.get(user.sub) ?? Promise.resolve();
    const attempt = previous.catch(() => undefined).then(() => this.startCallNow(user, rawNumber, options));
    this.starting.set(user.sub, attempt);
    try {
      return await attempt;
    } catch (err) {
      if (err instanceof HttpException) {
        const body = err.getResponse() as { code?: string };
        this.logger.warn(`call.start.refused org=${user.organizationId} user=${user.sub} code=${body.code ?? 'unknown'} reason="${maskDigits(messageOf(err))}"`);
      }
      throw err;
    } finally {
      if (this.starting.get(user.sub) === attempt) this.starting.delete(user.sub);
    }
  }

  private async startCallNow(user: JwtPayload, rawNumber: string, options: StartCallOptions): Promise<CallView> {
    const { dealId, provider: requested, requestKey } = options;
    if (requestKey) {
      const repeat = await this.findByRequestKey(user, requestKey);
      if (repeat) return repeat;
    }

    const customerNumber = this.twilio.normalize(rawNumber);
    if (!customerNumber) throw refusal(400, 'invalid_number', 'Enter the customer number with its country code, e.g. +44 7700 900123.');
    const problem = dialableProblem(customerNumber);
    if (problem) throw refusal(400, 'invalid_number', problem);

    const available = await this.availableProviders(user);
    if (available.length === 0) {
      throw refusal(400, 'no_line', 'You do not have a phone line yet. Ask an administrator to link a Plivo or Twilio number to you in Settings → Calling.');
    }
    const provider = chooseProvider(customerNumber, available, this.domesticCountryCode, requested);
    if (!provider) throw refusal(400, 'no_line', `You do not have a ${requested === 'twilio' ? 'Twilio' : 'Plivo'} line. Choose another route.`);

    // One call being set up at a time across both carriers — a second click would
    // ring the agent's phone twice and bill two calls.
    const [plivoBusy, twilioBusy] = await Promise.all([this.plivo.hasCallInProgress(user.sub), this.twilio.hasCallInProgress(user.sub)]);
    if (plivoBusy || twilioBusy) throw refusal(409, 'call_in_progress', 'A call is already being set up. Answer your phone, or wait a minute before trying again.');

    const extras = { clientRequestId: requestKey, customerName: options.customerName?.trim().slice(0, 120) || undefined };
    try {
      const call =
        provider === 'plivo'
          ? await this.plivo.startCall(user, { customerNumber, dealId }, true, extras)
          : await this.twilio.startCall(user, customerNumber, dealId, extras);
      this.logger.log(`call.start org=${user.organizationId} user=${user.sub} provider=${provider} call=${call._id.toString()} to=${maskPhone(customerNumber)}`);
      return toView(provider, call, new Date());
    } catch (err) {
      // Another process got the same tap first: that call is this one.
      if (requestKey && (err as { code?: number }).code === DUPLICATE_KEY_ERROR) {
        const repeat = await this.findByRequestKey(user, requestKey);
        if (repeat) return repeat;
      }
      if (err instanceof HttpException) {
        const message = messageOf(err);
        throw refusal(err.getStatus(), startRefusalCode(err.getStatus(), message), message);
      }
      throw err;
    }
  }

  private async findByRequestKey(user: JwtPayload, requestKey: string): Promise<CallView | null> {
    const [plivoCall, twilioCall] = await Promise.all([this.plivo.findByRequestKey(user, requestKey), this.twilio.findByRequestKey(user, requestKey)]);
    if (plivoCall) return toView('plivo', plivoCall, new Date());
    if (twilioCall) return toView('twilio', twilioCall, new Date());
    return null;
  }

  // ---- the call log -----------------------------------------------------------------

  async listCalls(user: JwtPayload, orgWide: boolean, before?: Date): Promise<CallView[]> {
    const [plivoCalls, twilioCalls] = await Promise.all([this.plivo.listCalls(user, orgWide, before), this.twilio.listCalls(user, orgWide, before)]);
    const now = new Date();
    const views = [...plivoCalls.map((c) => toView('plivo', c, now)), ...twilioCalls.map((c) => toView('twilio', c, now))]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, CALL_LOG_LIMIT);
    return this.withDetails(user.organizationId, views, now);
  }

  /** One of the caller's own calls, as it stands right now — what the Dialer's
   * live screen polls. `serverTime` lets it time the call on the server's clock. */
  async getCall(user: JwtPayload, provider: CallingProvider, id: string): Promise<CallView & { serverTime: Date }> {
    const call = provider === 'plivo' ? await this.plivo.getCallForUser(user, id, false) : await this.twilio.getCallForUser(user, id, false);
    const now = new Date();
    const [view] = await this.withDetails(user.organizationId, [toView(provider, call, now)], now);
    return { ...view, serverTime: now };
  }

  /** The report each call's recording became, and the name of the deal it was for. */
  private async withDetails(organizationId: string, views: CallView[], now: Date): Promise<CallView[]> {
    const sessionIds = [...new Set(views.map((v) => v.sessionId).filter((id): id is string => !!id && isValidObjectId(id)))];
    const dealIds = [...new Set(views.filter((v) => !v.customerName).map((v) => v.dealId).filter((id): id is string => !!id && isValidObjectId(id)))];
    const [sessions, deals] = await Promise.all([
      sessionIds.length
        ? this.sessionModel
            .find({ _id: { $in: sessionIds }, organizationId })
            .select('status overallScore headline coachingGeneratedAt endedAt updatedAt errorMessage')
            .lean()
            .exec()
        : Promise.resolve([]),
      dealIds.length ? this.dealModel.find({ _id: { $in: dealIds }, organizationId }).select('name').lean().exec() : Promise.resolve([]),
    ]);
    const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
    const dealName = new Map(deals.map((d) => [String(d._id), d.name]));
    return views.map((view) => {
      const session = view.sessionId ? sessionById.get(view.sessionId) : undefined;
      return {
        ...view,
        customerName: view.customerName ?? (view.dealId ? dealName.get(view.dealId) : undefined),
        ...(session
          ? {
              report: describeReport(
                {
                  sessionId: String(session._id),
                  status: session.status,
                  overallScore: session.overallScore,
                  headline: session.headline,
                  coachingGeneratedAt: session.coachingGeneratedAt,
                  endedAt: session.endedAt,
                  updatedAt: (session as { updatedAt?: Date }).updatedAt,
                  errorMessage: session.errorMessage,
                },
                now,
              ),
            }
          : {}),
      };
    });
  }

  /** "Try again" for a call's report. A recording that never got saved is
   * fetched from the provider again; one that was saved but whose transcription
   * failed (or was cut off by a restart) is reprocessed from the saved copy. */
  async retryImport(user: JwtPayload, provider: CallingProvider, id: string, orgWide: boolean): Promise<CallView> {
    const call = provider === 'plivo' ? await this.plivo.getCallForUser(user, id, orgWide) : await this.twilio.getCallForUser(user, id, orgWide);
    const stuck = call.importStatus === 'pending' && Date.now() - call.updatedAt.getTime() > IMPORT_STUCK_AFTER_MS;
    if (call.importStatus === 'failed' || stuck) {
      if (provider === 'plivo') await this.plivoWebhooks.importRecording(call as PlivoCallDocument);
      else await this.twilioWebhooks.importRecording(call as TwilioCallDocument);
    } else if (call.importStatus === 'imported' && call.sessionId) {
      // Throws a readable 4xx when there's nothing to retry (still running, already done).
      await this.uploads.retryProcessing(user.organizationId, call.sessionId, { languageCode: call.languageCode });
    }
    const fresh = provider === 'plivo' ? await this.plivo.getCallForUser(user, id, orgWide) : await this.twilio.getCallForUser(user, id, orgWide);
    const now = new Date();
    const [view] = await this.withDetails(user.organizationId, [toView(provider, fresh, now)], now);
    return view;
  }

  // ---- contacts -----------------------------------------------------------------------

  /** Customers to call, with their numbers: the whole business for those who see
   * all its customers (owners, admins, managers, or anyone given Customers), and
   * otherwise only the customers whose Customer Rep they are. */
  async searchContacts(user: JwtPayload, search: string): Promise<{ items: CallableCustomer[] }> {
    const text = (search ?? '').trim().slice(0, 80);
    if (text.length < 2) return { items: [] };
    const seesEveryone =
      user.roles.some((role) => role === 'owner' || role === 'admin' || role === 'manager') ||
      (isPermissionManaged(user) && !!user.permissions?.includes('customers:view'));
    return { items: await this.directory.searchCallable(user.organizationId, text, seesEveryone ? undefined : user.sub) };
  }
}
