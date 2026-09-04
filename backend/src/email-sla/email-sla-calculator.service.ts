import { Injectable } from '@nestjs/common';

export interface BusinessHoursPolicy {
  timezone: string;
  // 0=Sunday..6=Saturday, matching JS Date.getDay()/Intl's own weekday index.
  workingDays: number[];
  workingStartTime: string; // "HH:mm"
  workingEndTime: string; // "HH:mm"
  holidays: string[]; // "YYYY-MM-DD", evaluated in `timezone`
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sunday..6=Saturday
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Business-hours-aware SLA due-date calculator — pure, dependency-free
 * (no date-fns/luxon/dayjs/moment in this repo's package.json, confirmed
 * before writing this), DB-free, and unit-testable in isolation
 * (email-sla-calculator.spec.ts). Uses only native Date + Intl.DateTimeFormat
 * — the standard no-dependency technique for timezone-aware wall-clock math
 * in Node: format a UTC instant into a target timezone's local calendar
 * fields (getZonedParts), and invert that (zonedTimeToUtc) by adjusting an
 * initial guess against Intl's own reported offset at that instant. A
 * single adjustment pass is enough except within the ~1-hour window of a
 * DST transition itself, which this deliberately does not special-case —
 * flagged here rather than silently accepted.
 */
@Injectable()
export class EmailSlaCalculatorService {
  /** businessHoursEnabled:false is the 24/7 SLA case — plain calendar-time
   * addition, no timezone/holiday logic at all. */
  calculateDueAt(receivedAt: Date, slaMinutes: number, policy: BusinessHoursPolicy, businessHoursEnabled: boolean): Date {
    if (!businessHoursEnabled) {
      return new Date(receivedAt.getTime() + slaMinutes * 60_000);
    }
    return this.walkForwardBusinessMinutes(receivedAt, slaMinutes, policy);
  }

  private walkForwardBusinessMinutes(start: Date, minutesNeeded: number, policy: BusinessHoursPolicy): Date {
    const { hour: startHour, minute: startMinute } = parseTimeString(policy.workingStartTime);
    const { hour: endHour, minute: endMinute } = parseTimeString(policy.workingEndTime);
    if (endHour * 60 + endMinute - (startHour * 60 + startMinute) <= 0) {
      throw new Error(`Invalid business hours window: ${policy.workingStartTime}-${policy.workingEndTime}`);
    }

    let cursor = getZonedParts(start, policy.timezone);
    let remaining = minutesNeeded;

    // If the start instant already falls outside today's working window
    // (non-working day, holiday, before open, or after close), jump to the
    // next working day's opening time first — nothing is "consumed" from a
    // window we were never inside.
    if (!isWorkingDay(cursor, policy) || !isWithinWindow(cursor, startHour, startMinute, endHour, endMinute)) {
      cursor = nextWorkingDayStart(cursor, policy, startHour, startMinute, { skipToday: isWorkingDay(cursor, policy) && cursor.hour * 60 + cursor.minute >= endHour * 60 + endMinute });
    }

    // Walk forward day by day, consuming `remaining` against each working
    // day's full window, until it fits inside the current day.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const cursorMinutesIntoDay = cursor.hour * 60 + cursor.minute;
      const minutesLeftToday = endHour * 60 + endMinute - cursorMinutesIntoDay;

      if (remaining <= minutesLeftToday) {
        const dueMinutesIntoDay = cursorMinutesIntoDay + remaining;
        return zonedTimeToUtc(cursor.year, cursor.month, cursor.day, Math.floor(dueMinutesIntoDay / 60), dueMinutesIntoDay % 60, policy.timezone);
      }

      remaining -= minutesLeftToday;
      cursor = nextWorkingDayStart(cursor, policy, startHour, startMinute, { skipToday: true });
    }
  }
}

function parseTimeString(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':').map((n) => Number.parseInt(n, 10));
  return { hour: h || 0, minute: m || 0 };
}

function isWithinWindow(parts: ZonedParts, startHour: number, startMinute: number, endHour: number, endMinute: number): boolean {
  const minutesIntoDay = parts.hour * 60 + parts.minute;
  return minutesIntoDay >= startHour * 60 + startMinute && minutesIntoDay < endHour * 60 + endMinute;
}

function isHoliday(parts: ZonedParts, holidays: string[]): boolean {
  const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return holidays.includes(key);
}

function isWorkingDay(parts: ZonedParts, policy: BusinessHoursPolicy): boolean {
  return policy.workingDays.includes(parts.weekday) && !isHoliday(parts, policy.holidays);
}

/** Advances to the next working day's opening time. `skipToday: true` means
 * "today itself is done being consumed, start looking from tomorrow" —
 * `false` only applies on the very first call, when `cursor` might already
 * be sitting on a working day just before it opens (so today itself still
 * qualifies as "the next working day"). */
function nextWorkingDayStart(
  cursor: ZonedParts,
  policy: BusinessHoursPolicy,
  startHour: number,
  startMinute: number,
  opts: { skipToday: boolean },
): ZonedParts {
  let probe = zonedTimeToUtc(cursor.year, cursor.month, cursor.day, startHour, startMinute, policy.timezone);
  let probeParts = getZonedParts(probe, policy.timezone);
  if (opts.skipToday || !isWorkingDay(probeParts, policy)) {
    do {
      probe = new Date(probe.getTime() + 24 * 60 * 60 * 1000);
      probeParts = getZonedParts(probe, policy.timezone);
      // Re-anchor to the exact opening time on this calendar day (adding 24h
      // to a UTC instant can drift the local wall-clock hour across a DST
      // boundary) before re-checking whether it's a working day.
      probe = zonedTimeToUtc(probeParts.year, probeParts.month, probeParts.day, startHour, startMinute, policy.timezone);
      probeParts = getZonedParts(probe, policy.timezone);
    } while (!isWorkingDay(probeParts, policy));
  }
  return probeParts;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // hour12:false renders midnight as "24" in some ICU implementations —
  // normalize to 0.
  const hour = Number.parseInt(get('hour'), 10) % 24;
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour,
    minute: Number.parseInt(get('minute'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Inverse of getZonedParts — the UTC instant whose wall-clock time in
 * `timeZone` is exactly (year, month, day, hour, minute). Standard
 * guess-and-correct technique: treat the target wall-clock fields as if
 * they were already UTC, see what that instant actually displays as in
 * `timeZone`, then shift by the difference. */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wantedUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guess = new Date(wantedUtcMs);
  const gotParts = getZonedParts(guess, timeZone);
  const gotUtcMs = Date.UTC(gotParts.year, gotParts.month - 1, gotParts.day, gotParts.hour, gotParts.minute, 0);
  return new Date(wantedUtcMs + (wantedUtcMs - gotUtcMs));
}
