import type { CallOutcome } from '@/services/callCopilotService';

export type ChipTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

// How the AI's read of a call ended up, in plain words.
export const OUTCOME_META: Record<CallOutcome, { label: string; tone: ChipTone }> = {
  moving_forward: { label: 'Moving forward', tone: 'success' },
  needs_follow_up: { label: 'Needs follow-up', tone: 'warning' },
  objection_raised: { label: 'Objection raised', tone: 'danger' },
  no_decision: { label: 'No decision yet', tone: 'neutral' },
  lost: { label: 'Lost', tone: 'danger' },
  not_applicable: { label: 'Not a sales call', tone: 'neutral' },
};

export type CallKind = 'live' | 'phone' | 'upload';

// Phone calls placed through Plivo arrive as uploads named plivo-<recording>.mp3
// (see backend/src/plivo). Calling them what they are is far clearer than "Uploaded".
export function describeSource(
  source: 'live' | 'upload' | undefined,
  filename?: string,
): { kind: CallKind; label: string } {
  if (source === 'live') return { kind: 'live', label: 'Recorded live' };
  if (filename?.startsWith('plivo-')) return { kind: 'phone', label: 'Phone call' };
  return { kind: 'upload', label: 'Uploaded' };
}

export function formatCallDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Calls that failed before 2026-11-11 stored the raw HTTP error ("Request failed
// with status code 502"); newer ones store a sentence written for the user.
const RAW_ERROR = /^(Request failed with status code \d+|connect E[A-Z]+|timeout of \d+ms exceeded|Network Error)/i;

/** Why a call's recording couldn't be processed, always in words. */
export function failureReason(errorMessage: string | undefined): string {
  if (!errorMessage || RAW_ERROR.test(errorMessage.trim())) {
    return (
      'HaiVE’s AI service couldn’t transcribe this recording at the time ' +
      '(for example, the speech-to-text account was out of credits).'
    );
  }
  return errorMessage;
}
