import type { CallFailure, CallingCall } from '@/services/callingService';
import { formatNumber } from './dialRules';

const FAILURE_SHORT: Record<CallFailure, string> = {
  busy: 'Busy',
  no_answer_customer: 'No answer',
  no_answer_agent: 'You didn’t answer',
  invalid_number: 'Wrong number',
  offline: 'Calling offline',
  balance: 'No calling balance',
  cancelled: 'Cancelled',
  provider_error: 'Didn’t connect',
};

export type CallTone = 'ok' | 'live' | 'missed' | 'muted';

/** "2:14", "Busy", "In call" — a call's state in a word or two, for lists. */
export function callStatus(call: CallingCall): { label: string; tone: CallTone } {
  const stage = call.outcome?.stage;
  if (stage === 'ringing_agent' || stage === 'connecting_customer') return { label: 'Calling…', tone: 'live' };
  if (stage === 'in_call') return { label: 'In call', tone: 'live' };
  if (stage === 'failed' && call.outcome?.failure) return { label: FAILURE_SHORT[call.outcome.failure], tone: 'missed' };
  if (stage === 'failed') return { label: 'Didn’t connect', tone: 'missed' };
  return { label: call.durationSeconds ? duration(call.durationSeconds) : 'Call ended', tone: 'ok' };
}

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = String(Math.round(seconds % 60)).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Who the call was with: the customer's name when known, else their number. */
export function callName(call: CallingCall): string {
  return call.customerName?.trim() || formatNumber(call.customerNumber);
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dayGroup(iso: string, now = new Date()): 'Today' | 'Yesterday' | 'Earlier' {
  const date = new Date(iso);
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return sameDay(date, yesterday) ? 'Yesterday' : 'Earlier';
}

/** "10:42" today and yesterday; "3 Nov" before that. */
export function callTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return dayGroup(iso, now) === 'Earlier'
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Same bands as Call Copilot's score ring (features/call-copilot/components/ScoreRing). */
export function scoreTone(score: number): 'good' | 'fair' | 'low' {
  if (score >= 7) return 'good';
  if (score >= 4) return 'fair';
  return 'low';
}
