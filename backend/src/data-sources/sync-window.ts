// A CRM that may be read only inside a nightly window (Hoops: once a night,
// after 7:00pm AEST). The python sync enforces it for every trigger
// (python-agent/app/integrations/crm_mongo_sync.py, "nightly sync window");
// this mirror only tells people when the next sync runs and whether "Sync now"
// can work — a change to the rule needs the same change there.

export interface SyncWindow {
  // A real IANA zone (DST-aware) — e.g. "Australia/Sydney", which observes
  // AEDT (UTC+11) roughly Oct-Apr, not AEST (UTC+10) year-round. Preferred
  // over utcOffsetMinutes whenever set.
  timezone?: string;
  // Fallback only, for a window saved before `timezone` existed: a FIXED
  // offset with no daylight saving — kept so an old stored document still
  // resolves to something, never because a new window should set this
  // instead of timezone.
  utcOffsetMinutes?: number;
  // "HH:MM", local to the zone/offset. An end before the start runs past midnight.
  start: string;
  end: string;
  label: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The real UTC offset (minutes) window's zone observes AT this exact
 * instant — DST-aware when `timezone` is set, so this mirror never drifts
 * from python's zoneinfo-based enforcement (crm_mongo_sync.py's own
 * _window_tz) across a daylight-saving transition. Falls back to the
 * fixed utcOffsetMinutes for a window that predates `timezone`. */
function offsetMinutesAt(window: SyncWindow, at: Date): number {
  if (!window.timezone) return window.utcOffsetMinutes ?? 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asLocalReadAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asLocalReadAsUtc - at.getTime()) / 60_000);
}

/** The local date the window opened on, if `at` is inside a window ("YYYY-MM-DD"), else null. */
export function windowNight(window: SyncWindow, at: Date): string | null {
  const local = new Date(at.getTime() + offsetMinutesAt(window, at) * 60_000);
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minutes(window.start);
  const end = minutes(window.end);
  const today = local.toISOString().slice(0, 10);
  if (start <= end) return now >= start && now < end ? today : null;
  if (now >= start) return today;
  if (now < end) return new Date(local.getTime() - 86_400_000).toISOString().slice(0, 10);
  return null;
}

function opensOn(window: SyncWindow, night: string): Date {
  const start = minutes(window.start);
  // The zone's offset exactly at local midnight of this night — close
  // enough to the real opening instant (hours later, same local day) to
  // always land on the correct side of a DST transition, since AU/NZ-style
  // transitions never happen between midnight and 7pm local.
  const offset = offsetMinutesAt(window, new Date(Date.parse(`${night}T00:00:00Z`)));
  return new Date(Date.parse(`${night}T00:00:00Z`) + (start - offset) * 60_000);
}

/** When the next night's window opens after `at` (tonight's, if it hasn't opened yet). */
export function nextWindowOpening(window: SyncWindow, at: Date): Date {
  const night = windowNight(window, at);
  if (night) return opensOn(window, new Date(Date.parse(`${night}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
  const localDate = new Date(at.getTime() + offsetMinutesAt(window, at) * 60_000).toISOString().slice(0, 10);
  const opens = opensOn(window, localDate);
  return opens > at ? opens : opensOn(window, new Date(Date.parse(`${localDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
}

/** "7:00pm AEST" — when the window opens, as people read it. */
export function windowOpensLabel(window: SyncWindow): string {
  const [h, m] = window.start.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} ${window.label}`.trim();
}

export interface WindowSchedule {
  window: SyncWindow;
  // When the next automatic sync can run.
  nextRunAt: Date;
  canSyncNow: boolean;
  // Why "Sync now" can't run, in plain words (only when it can't).
  reason?: string;
}

export function windowSchedule(window: SyncWindow, sourceLabel: string, lastSuccessAt: Date | undefined, now = new Date()): WindowSchedule {
  const night = windowNight(window, now);
  const opens = windowOpensLabel(window);
  if (!night) {
    return {
      window,
      nextRunAt: nextWindowOpening(window, now),
      canSyncNow: false,
      reason: `${sourceLabel} allows HaiVE to read once a night, after ${opens}. The next sync runs then by itself.`,
    };
  }
  if (lastSuccessAt && windowNight(window, lastSuccessAt) === night) {
    return {
      window,
      nextRunAt: nextWindowOpening(window, now),
      canSyncNow: false,
      reason: `Already synced tonight — ${sourceLabel} allows one sync a night. The next one runs after ${opens} tomorrow.`,
    };
  }
  return { window, nextRunAt: now, canSyncNow: true };
}
