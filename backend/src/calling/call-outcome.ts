// Where a phone call stands, in the words the person who placed it needs —
// "Ringing your phone…", "The customer's line was busy." — worked out from what
// Plivo/Twilio have reported so far. Pure (time is passed in), so the Dialer's
// live screen, its call log and the tests all read the same rules.

import { PROCESSING_ABANDONED_AFTER_MS } from '../call-copilot/processing-failure';
import type { CallingProvider } from './calling-routing';

export type CallStage = 'ringing_agent' | 'connecting_customer' | 'in_call' | 'ended' | 'failed';

export type CallFailure =
  | 'busy'
  | 'no_answer_customer'
  | 'no_answer_agent'
  | 'invalid_number'
  | 'offline'
  | 'balance'
  | 'cancelled'
  | 'provider_error';

export const CALL_FAILURES: readonly CallFailure[] = [
  'busy',
  'no_answer_customer',
  'no_answer_agent',
  'invalid_number',
  'offline',
  'balance',
  'cancelled',
  'provider_error',
];

export interface CallOutcome {
  stage: CallStage;
  failure?: CallFailure;
  // One sentence for the person who placed the call.
  message: string;
}

export interface CallFacts {
  provider: CallingProvider;
  direction: 'outbound' | 'inbound';
  status: string;
  failureReason?: string;
  failureCode?: string;
  // The agent's own phone picked up (the call was then put through to the customer).
  agentAnswered?: boolean;
  // The far end picked up: the customer (outbound) or the agent (inbound).
  answeredAt?: Date;
  createdAt: Date;
}

// The agent's phone rings for up to 45 s; past this with no word from the carrier
// at all, none of its callbacks is reaching us (the tunnel or the server is down).
export const NO_REPORT_AFTER_MS = 90_000;
// Past the carriers' own 4-hour call limit a call still marked live never got its
// hangup report (same rule as isCallStale in frontend/src/services/plivoService.ts).
export const STALE_AFTER_MS = 5 * 60 * 60_000;

const PROVIDER_NAME: Record<CallingProvider, string> = { plivo: 'Plivo', twilio: 'Twilio' };

// Plivo's own wording before the busy/no-answer fix: the reason was right, the
// status had been overwritten with "completed" by the agent's leg ending.
const LEGACY_REASON: Record<string, string> = { busy: 'busy', 'no answer': 'no_answer', failed: 'failed', cancelled: 'cancelled' };

function failureMessage(failure: CallFailure, facts: CallFacts): string {
  switch (failure) {
    case 'busy':
      return facts.direction === 'outbound' ? "The customer's line was busy." : 'Your phone was busy.';
    case 'no_answer_customer':
      return "The customer didn't answer.";
    case 'no_answer_agent':
      return facts.direction === 'outbound' ? "Your phone wasn't answered, so the customer wasn't called." : "Your phone wasn't answered.";
    case 'invalid_number':
      return "That number can't be reached. Check the number and its country code.";
    case 'offline':
      return "Calling is offline: the phone system couldn't reach HaiVE, so the customer wasn't connected. Ask an administrator to check calling.";
    case 'balance':
      return `There isn't enough calling balance on the ${PROVIDER_NAME[facts.provider]} account. Ask an administrator to top it up.`;
    case 'cancelled':
      return 'The call was cancelled.';
    case 'provider_error':
      return facts.failureReason?.trim() || "The call couldn't be connected.";
  }
}

/** Which failure a carrier's message (or hangup cause) describes, when it is one we can name. */
export function classifyFailureText(text: string | undefined): CallFailure | undefined {
  if (!text) return undefined;
  if (/insufficient (balance|funds|credit)|low balance|not enough (balance|credit)|recharge/i.test(text)) return 'balance';
  if (/error reaching answer url|answer url|could not reach haive|calling is offline/i.test(text)) return 'offline';
  if (/unallocated|invalid[ _](destination|number)|invalid_number_format|no_route|not a valid|is not valid|cannot be reached|not valid for calling/i.test(text)) {
    return 'invalid_number';
  }
  return undefined;
}

export function describeCall(facts: CallFacts, now: Date): CallOutcome {
  const failed = (failure: CallFailure): CallOutcome => ({ stage: 'failed', failure, message: failureMessage(failure, facts) });
  if (facts.failureCode && (CALL_FAILURES as readonly string[]).includes(facts.failureCode)) return failed(facts.failureCode as CallFailure);

  const age = now.getTime() - facts.createdAt.getTime();
  let status = facts.status;
  if (status === 'completed') {
    const legacy = /^Call (busy|no answer|failed|cancelled)\.$/i.exec(facts.failureReason ?? '');
    if (legacy) status = LEGACY_REASON[legacy[1].toLowerCase()];
  }

  switch (status) {
    case 'initiated':
      if (age > NO_REPORT_AFTER_MS) return failed('offline');
      return { stage: 'ringing_agent', message: facts.direction === 'outbound' ? 'Ringing your phone…' : 'Incoming call…' };
    case 'in_progress':
      if (age > STALE_AFTER_MS) return { stage: 'ended', message: 'No final report came from the phone system.' };
      if (facts.answeredAt) return { stage: 'in_call', message: 'In call' };
      return facts.direction === 'outbound'
        ? { stage: 'connecting_customer', message: 'Connecting the customer…' }
        : { stage: 'ringing_agent', message: 'Ringing your phone…' };
    case 'completed':
      return { stage: 'ended', message: 'Call ended' };
    case 'busy':
      return failed(facts.direction === 'outbound' && facts.agentAnswered === false ? 'no_answer_agent' : 'busy');
    case 'no_answer': {
      // Twilio said so in words; Plivo's older calls show it by never having
      // answered our Answer webhook.
      const agentMissed = facts.agentAnswered === false || /your phone/i.test(facts.failureReason ?? '');
      return failed(facts.direction === 'outbound' && agentMissed ? 'no_answer_agent' : 'no_answer_customer');
    }
    case 'cancelled':
      return failed('cancelled');
    default:
      return failed(classifyFailureText(facts.failureReason) ?? 'provider_error');
  }
}

// ---- the call's report (its Call Copilot session) ------------------------------

export type ReportStage = 'transcribing' | 'scoring' | 'ready' | 'failed';

export interface ReportSummary {
  sessionId: string;
  stage: ReportStage;
  overallScore?: number;
  headline?: string;
  // Ready, but the AI Coach never produced a score (it can be generated on demand).
  unscored?: boolean;
  error?: string;
}

export interface ReportFacts {
  sessionId: string;
  status: string;
  overallScore?: number;
  headline?: string;
  coachingGeneratedAt?: Date;
  endedAt?: Date;
  updatedAt?: Date;
  errorMessage?: string;
}

// Coaching runs a minute or so after the summary; past this it isn't coming.
export const SCORING_GIVES_UP_AFTER_MS = 5 * 60_000;
// Transcribing a long call takes minutes, not this long — past it the pipeline is
// gone (e.g. a restart), and "Try again" is accepted from the same moment.
export const PROCESSING_GIVES_UP_AFTER_MS = PROCESSING_ABANDONED_AFTER_MS;

export function describeReport(facts: ReportFacts, now: Date): ReportSummary {
  const base = { sessionId: facts.sessionId, overallScore: facts.overallScore, headline: facts.headline };
  if (facts.status === 'error') return { ...base, stage: 'failed', error: facts.errorMessage || 'The recording could not be processed.' };
  if (facts.coachingGeneratedAt) return { ...base, stage: 'ready', ...(facts.overallScore === undefined ? { unscored: true } : {}) };
  if (facts.status === 'ended') {
    const since = facts.endedAt ?? facts.updatedAt;
    if (since && now.getTime() - since.getTime() > SCORING_GIVES_UP_AFTER_MS) return { ...base, stage: 'ready', unscored: true };
    return { ...base, stage: 'scoring' };
  }
  if (facts.updatedAt && now.getTime() - facts.updatedAt.getTime() > PROCESSING_GIVES_UP_AFTER_MS) {
    return { ...base, stage: 'failed', error: 'Processing stopped before the report was finished (the server may have restarted).' };
  }
  return { ...base, stage: 'transcribing' };
}

// ---- why a call could not be started ----------------------------------------------

export type StartRefusal = 'invalid_number' | 'own_number' | 'no_line' | 'not_ready' | 'call_in_progress' | 'balance' | 'offline' | 'provider_error';

/** A code for the Dialer to word a refused start by, from the refusal's own message. */
export function startRefusalCode(httpStatus: number, message: string): StartRefusal {
  if (httpStatus === 409) return 'call_in_progress';
  if (/your own number/i.test(message)) return 'own_number';
  if (/do not have a .*line/i.test(message)) return 'no_line';
  if (/not connected|not fully set up|PUBLIC_BASE_URL/i.test(message)) return 'not_ready';
  const failure = classifyFailureText(message);
  if (failure === 'balance' || failure === 'offline' || failure === 'invalid_number') return failure;
  return 'provider_error';
}

// ---- can the phone network reach us? ---------------------------------------------

export type Reachability = 'reachable' | 'unreachable' | 'unknown' | 'not_configured';

export interface ProbeResult {
  status?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
  // Node's network error code (ECONNREFUSED, ENOTFOUND, ETIMEDOUT…).
  errorCode?: string;
}

/**
 * What one request to our own public address says. "Unreachable" only on a
 * clear sign (an ngrok "endpoint offline" page, nothing listening, a name that
 * doesn't resolve, a proxy that can't reach us) — anything ambiguous is
 * "unknown", so a quirk of the check itself never blocks calling.
 */
export function reachabilityOf(probe: ProbeResult): Reachability {
  if (probe.errorCode) return ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(probe.errorCode) ? 'unreachable' : 'unknown';
  const headers = probe.headers ?? {};
  if (headers['ngrok-error-code']) return 'unreachable';
  const body = probe.body as { service?: unknown } | string | undefined;
  if (probe.status === 200 && typeof body === 'object' && body?.service === 'backend') return 'reachable';
  if (typeof body === 'string' && /ERR_NGROK_\d+/.test(body)) return 'unreachable';
  if (probe.status === 502 || probe.status === 503 || probe.status === 504) return 'unreachable';
  return 'unknown';
}
