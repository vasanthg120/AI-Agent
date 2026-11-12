// A business's own calendar day, in its own timezone (Organization.timezone,
// default Asia/Kolkata): "today" for a Sydney business starts at midnight in
// Sydney, not in India or in UTC. Team Performance counts every "today" /
// "yesterday" / date-range figure against these bounds.
//
// Built on Intl (full ICU ships with Node), no date library: the offset of a
// zone at an instant is read back from Intl's own wall-clock parts.

export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

/** The zone if Intl knows it, else the default (a typo in settings must never break a report). */
export function validTimeZone(timeZone: string | undefined | null): string {
  if (!timeZone) return DEFAULT_BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

/** Wall-clock parts of an instant in a zone. */
function partsIn(timeZone: string, instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Minutes the zone is ahead of UTC at that instant (IST: 330; Sydney: 600 or 660). */
function offsetMinutes(timeZone: string, instant: Date): number {
  const p = partsIn(timeZone, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The instant a "YYYY-MM-DD" day starts in the zone (daylight saving included). */
export function startOfBusinessDay(timeZone: string, ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Two passes: the offset at local midnight can differ from the offset at UTC midnight on a DST change day.
  let guess = utcMidnight - offsetMinutes(timeZone, new Date(utcMidnight)) * 60000;
  guess = utcMidnight - offsetMinutes(timeZone, new Date(guess)) * 60000;
  return new Date(guess);
}

/** The "YYYY-MM-DD" day an instant falls on in the zone. */
export function businessDayOf(timeZone: string, instant: Date): string {
  const p = partsIn(timeZone, instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The "YYYY-MM-DD" day after this one. */
export function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Half-open [start, end) instants covering whole business days from dateFrom
 * through dateTo ("YYYY-MM-DD", both included), in the zone.
 */
export function businessDayRange(timeZone: string, dateFrom: string, dateTo: string): { start: Date; end: Date } {
  const zone = validTimeZone(timeZone);
  const last = dateTo < dateFrom ? dateFrom : dateTo;
  return { start: startOfBusinessDay(zone, dateFrom), end: startOfBusinessDay(zone, nextDay(last)) };
}
