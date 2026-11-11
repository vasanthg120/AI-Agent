import { HttpException, HttpStatus } from '@nestjs/common';
import { AxiosError } from 'axios';

// Why a recorded call's processing (transcript → summary) failed: one sentence
// the salesperson can act on, and the technical reason for the server log.
// Pure, so every surface (Dialer, call log, Call Library, notification) shows
// the same words and the spec can pin them down.

/** How long the background pipeline may poll Sarvam for one recording. */
export const TRANSCRIPTION_MAX_WAIT_MS = 60 * 60_000;

/** A 'processing' session nobody has saved for this long has no pipeline behind
 * it any more (the server restarted part-way), so it may be processed again.
 * Longer than TRANSCRIPTION_MAX_WAIT_MS, the one stretch in which a working
 * pipeline doesn't save the session. */
export const PROCESSING_ABANDONED_AFTER_MS = TRANSCRIPTION_MAX_WAIT_MS + 10 * 60_000;

export class TranscriptionTimedOutError extends Error {
  constructor() {
    super('Sarvam batch job still running after the polling deadline');
  }
}

export class SarvamJobFailedError extends Error {
  constructor(readonly reason: string) {
    super(`Sarvam batch job failed: ${reason}`);
  }
}

export class NoSpeechFoundError extends Error {
  constructor() {
    super('Sarvam returned an empty transcript');
  }
}

export interface ProcessingFailure {
  /** Shown to the user (stored as the session's errorMessage). */
  message: string;
  /** For the log only — may name hosts, codes and HTTP statuses. */
  technical: string;
}

const NETWORK_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE']);
const NETWORK_SLOW = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The `detail` of an HTTPException python-agent raised — already written for users. */
function agentDetail(err: unknown): string | null {
  const detail = (err as AxiosError<{ detail?: unknown }>).response?.data?.detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
}

/** A failure worth waiting out while polling: python-agent restarting, a network
 * blip, or a gateway error — not a refusal that will just repeat. */
export function isTransientAgentError(err: unknown): boolean {
  const axiosErr = err as AxiosError;
  if (!axiosErr?.isAxiosError) return false;
  const status = axiosErr.response?.status;
  if (status === undefined) return true; // no answer at all
  return status === 502 || status === 503 || status === 504;
}

export function describeProcessingFailure(err: unknown): ProcessingFailure {
  if (err instanceof NoSpeechFoundError) {
    return { message: 'No speech was found in this recording, so there was nothing to transcribe.', technical: err.message };
  }
  if (err instanceof TranscriptionTimedOutError) {
    return { message: 'Transcribing this call took more than an hour, so HaiVE stopped waiting.', technical: err.message };
  }
  if (err instanceof SarvamJobFailedError) {
    return { message: `Sarvam AI couldn’t transcribe this recording: ${sentence(err.reason)}`, technical: err.message };
  }

  if (err instanceof HttpException) {
    const response = err.getResponse() as { code?: string } | string;
    if (err.getStatus() === HttpStatus.PAYMENT_REQUIRED || (typeof response === 'object' && response?.code === 'INSUFFICIENT_BALANCE')) {
      return { message: 'Your HaiVE credits ran out before this call could be processed. Add credits, then try again.', technical: err.message };
    }
    return { message: sentence(err.message), technical: `${err.getStatus()} ${err.message}` };
  }

  const axiosErr = err as AxiosError;
  if (axiosErr?.isAxiosError) {
    const status = axiosErr.response?.status;
    const where = axiosErr.config?.url?.replace(/\?.*$/, '') ?? 'python-agent';
    const detail = agentDetail(err);
    const technical = `${status ? `HTTP ${status}` : (axiosErr.code ?? 'no response')} from ${where}${detail ? `: ${detail}` : ''}`;
    if (detail) return { message: sentence(detail), technical };
    if (status === undefined && NETWORK_SLOW.has(axiosErr.code ?? '')) {
      return { message: 'HaiVE’s AI service took too long to answer. Try again in a minute.', technical };
    }
    if (status === undefined) {
      return { message: 'HaiVE’s AI service isn’t running, so this call couldn’t be transcribed. Try again once it’s back.', technical };
    }
    if (status === 401 || status === 403) {
      return { message: 'HaiVE couldn’t sign in to its AI service. An administrator needs to check the server settings.', technical };
    }
    if (status === 413) return { message: 'This recording is too large to transcribe.', technical };
    return { message: 'HaiVE’s AI service ran into a problem while processing this call. Try again in a minute.', technical };
  }

  const technical = err instanceof Error ? err.message : String(err);
  if (NETWORK_DOWN.has((err as { code?: string })?.code ?? '')) {
    return { message: 'HaiVE’s AI service isn’t running, so this call couldn’t be transcribed. Try again once it’s back.', technical };
  }
  return { message: 'Something went wrong while processing this call.', technical };
}
