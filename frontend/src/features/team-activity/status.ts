import dayjs from 'dayjs';

export type ActivityTone = 'now' | 'today' | 'earlier' | 'never';

/** Active in HaiVE in the last five minutes counts as "now" (the browser reports once a minute). */
const NOW_MS = 5 * 60_000;

/**
 * Where someone stands, from the last minute they were really active in HaiVE:
 * "Active now", "Active 25m ago", "Active yesterday", "Active 3 Nov" — or, never
 * measured, "No app time yet". Never from a tab merely being open.
 */
export function activityStatus(lastActiveAt: string | undefined, now = Date.now()): { tone: ActivityTone; label: string } {
  if (!lastActiveAt) return { tone: 'never', label: 'No app time yet' };
  const at = dayjs(lastActiveAt);
  const ago = now - at.valueOf();
  if (ago < NOW_MS) return { tone: 'now', label: 'Active now' };
  if (ago < 60 * 60_000) return { tone: 'today', label: `Active ${Math.max(1, Math.round(ago / 60_000))}m ago` };
  if (at.isSame(dayjs(now), 'day')) return { tone: 'today', label: `Active ${Math.round(ago / 3_600_000)}h ago` };
  if (at.isSame(dayjs(now).subtract(1, 'day'), 'day')) return { tone: 'earlier', label: 'Active yesterday' };
  return { tone: 'earlier', label: `Active ${at.format('D MMM')}` };
}

/** Change from the period before, as a whole percentage (null when there is nothing to compare with). */
export function changePct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}
