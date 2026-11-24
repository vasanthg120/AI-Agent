import { randomUUID } from 'crypto';
import { VOICE_LANGUAGE_CODES, VoiceLanguageCode } from '../voice/dto/voice-languages';

// How Haive talks to one person: whether it speaks, when it greets, in what
// language and how much, which figures it watches, when it may start a
// conversation on its own (schedules, alerts) and when it must stay quiet.
// Each person may set their own; an owner or admin can save a company default
// that everyone without their own settings follows.

export const METRICS = ['revenue', 'pipeline', 'quotations', 'emails', 'calls', 'tasks', 'team', 'syncHealth'] as const;
export type Metric = (typeof METRICS)[number];

export const GREETINGS = ['first_of_day', 'every_login', 'tap'] as const;
export type Greeting = (typeof GREETINGS)[number];

export const STYLES = ['concise', 'detailed'] as const;
export type SpeakingStyle = (typeof STYLES)[number];

export const MAX_SCHEDULES = 6;
export const MAX_QUESTIONS = 12;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A time Haive starts a conversation: a notification with headline figures; the briefing is written when it's opened. */
export interface ConversationSchedule {
  id: string;
  label: string;
  // HH:mm in the person's time zone.
  time: string;
  // ISO weekdays: 1 = Monday … 7 = Sunday.
  days: number[];
  enabled: boolean;
}

export interface AiConversationSettings {
  // Off: Haive is text only — it never speaks and the microphone is hidden.
  voiceEnabled: boolean;
  // When it greets out loud: the first sign-in of the day, every sign-in, or only when tapped.
  greeting: Greeting;
  language: VoiceLanguageCode;
  style: SpeakingStyle;
  // Prepare the briefing on sign-in (off: only when asked for).
  briefingEnabled: boolean;
  // Null = the business's own time zone.
  timeZone: string | null;
  schedules: ConversationSchedule[];
  // Questions Haive suggests and keeps in mind (the briefing prefers the ones today's facts make relevant).
  questions: { text: string; enabled: boolean }[];
  metrics: Record<Metric, boolean>;
  // Start a conversation when something needs attention (a missed enquiry, a broken sync, a deal past its date).
  alerts: boolean;
  notify: { bell: boolean; phone: boolean };
  // Nothing proactive between these times (the briefing on sign-in still works).
  quietHours: { enabled: boolean; start: string; end: string };
  // Proactive conversations (schedules + alerts) a day, at most.
  maxPerDay: number;
}

export type SettingsSource = 'mine' | 'organization' | 'default';

export const DEFAULT_QUESTIONS = [
  'How is our revenue pipeline performing?',
  'Which sales opportunities need attention?',
  'Which customers have pending quotations?',
  "Which customers haven't received follow-ups?",
  'What are our expected conversions this week?',
  'How is each salesperson performing?',
  'What should our sales team prioritise today?',
  'Which opportunities could generate the most revenue?',
];

export function defaultSettings(): AiConversationSettings {
  return {
    voiceEnabled: true,
    greeting: 'first_of_day',
    language: 'en',
    style: 'concise',
    briefingEnabled: true,
    timeZone: null,
    schedules: [],
    questions: DEFAULT_QUESTIONS.map((text) => ({ text, enabled: true })),
    metrics: Object.fromEntries(METRICS.map((m) => [m, true])) as Record<Metric, boolean>,
    alerts: true,
    notify: { bell: true, phone: true },
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
    maxPerDay: 3,
  };
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const time = (value: unknown, fallback: string) => (typeof value === 'string' && TIME_PATTERN.test(value) ? value : fallback);

/**
 * Settings as saved (or sent), made whole and safe: anything missing or not
 * understood takes the value it falls back on, lists are capped, duplicates and
 * blanks dropped, and every schedule has an id. Used on the way in and out, so
 * a document written by an older version still reads correctly.
 */
export function cleanSettings(input: Partial<AiConversationSettings> | null | undefined, base: AiConversationSettings = defaultSettings()): AiConversationSettings {
  const s = (input ?? {}) as Partial<AiConversationSettings> & Record<string, unknown>;
  const seenQuestions = new Set<string>();
  const questions = Array.isArray(s.questions)
    ? s.questions
        .filter((q) => q && typeof q.text === 'string')
        .map((q) => ({ text: q.text.replace(/\s+/g, ' ').trim().slice(0, 120), enabled: bool(q.enabled, true) }))
        .filter((q) => q.text.length > 0 && !seenQuestions.has(q.text.toLowerCase()) && seenQuestions.add(q.text.toLowerCase()))
        .slice(0, MAX_QUESTIONS)
    : base.questions;
  const seenIds = new Set<string>();
  const schedules = Array.isArray(s.schedules)
    ? s.schedules
        .filter((x) => x && typeof x.time === 'string' && TIME_PATTERN.test(x.time))
        .map((x) => {
          let id = typeof x.id === 'string' && /^[a-z0-9-]{1,36}$/i.test(x.id) ? x.id : randomUUID().slice(0, 8);
          if (seenIds.has(id)) id = randomUUID().slice(0, 8);
          seenIds.add(id);
          const days = [...new Set((Array.isArray(x.days) ? x.days : []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
          return { id, label: (typeof x.label === 'string' ? x.label.trim() : '').slice(0, 40) || 'Briefing', time: x.time, days: days.length ? days : [1, 2, 3, 4, 5], enabled: bool(x.enabled, true) };
        })
        .sort((a, b) => a.time.localeCompare(b.time))
        .slice(0, MAX_SCHEDULES)
    : base.schedules;
  const metricsIn = (s.metrics ?? {}) as Partial<Record<Metric, unknown>>;
  return {
    voiceEnabled: bool(s.voiceEnabled, base.voiceEnabled),
    greeting: GREETINGS.includes(s.greeting as Greeting) ? (s.greeting as Greeting) : base.greeting,
    language: VOICE_LANGUAGE_CODES.includes(s.language as VoiceLanguageCode) ? (s.language as VoiceLanguageCode) : base.language,
    style: STYLES.includes(s.style as SpeakingStyle) ? (s.style as SpeakingStyle) : base.style,
    briefingEnabled: bool(s.briefingEnabled, base.briefingEnabled),
    timeZone: s.timeZone === null ? null : typeof s.timeZone === 'string' && isTimeZone(s.timeZone) ? s.timeZone : base.timeZone,
    schedules,
    questions,
    metrics: Object.fromEntries(METRICS.map((m) => [m, bool(metricsIn[m], base.metrics[m])])) as Record<Metric, boolean>,
    alerts: bool(s.alerts, base.alerts),
    notify: { bell: bool(s.notify?.bell, base.notify.bell), phone: bool(s.notify?.phone, base.notify.phone) },
    quietHours: {
      enabled: bool(s.quietHours?.enabled, base.quietHours.enabled),
      start: time(s.quietHours?.start, base.quietHours.start),
      end: time(s.quietHours?.end, base.quietHours.end),
    },
    maxPerDay: Number.isInteger(s.maxPerDay) && (s.maxPerDay as number) >= 0 && (s.maxPerDay as number) <= 10 ? (s.maxPerDay as number) : base.maxPerDay,
  };
}

/** The clock in a time zone: "HH:mm" and the ISO weekday (1 = Monday). */
export function localClock(timeZone: string, now: Date): { time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short', timeZone }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { time: `${get('hour')}:${get('minute')}`, weekday };
}

/** Inside quiet hours (which may run past midnight, e.g. 20:00–08:00). */
export function inQuietHours(quiet: AiConversationSettings['quietHours'], clock: string): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? clock >= quiet.start && clock < quiet.end : clock >= quiet.start || clock < quiet.end;
}
