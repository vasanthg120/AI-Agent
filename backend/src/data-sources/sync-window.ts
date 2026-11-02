// A CRM that may be read only inside a nightly window (Hoops: once a night,
// after 7:00pm AEST). The python sync enforces it for every trigger
// (python-agent/app/integrations/crm_mongo_sync.py, "nightly sync window");
// this mirror only tells people when the next sync runs and whether "Sync now"
// can work — a change to the rule needs the same change there.

export interface SyncWindow {
  // Fixed offset, not a named zone: AEST is UTC+10 all year (no daylight saving).
  utcOffsetMinutes: number;
  // "HH:MM", local to the offset. An end before the start runs past midnight.
  start: string;
  end: string;
  label: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The local date the window opened on, if `at` is inside a window ("YYYY-MM-DD"), else null. */
export function windowNight(window: SyncWindow, at: Date): string | null {
  const local = new Date(at.getTime() + window.utcOffsetMinutes * 60_000);
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
  return new Date(Date.parse(`${night}T00:00:00Z`) + (start - window.utcOffsetMinutes) * 60_000);
}

/** When the next night's window opens after `at` (tonight's, if it hasn't opened yet). */
export function nextWindowOpening(window: SyncWindow, at: Date): Date {
  const night = windowNight(window, at);
  if (night) return opensOn(window, new Date(Date.parse(`${night}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
  const localDate = new Date(at.getTime() + window.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
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
