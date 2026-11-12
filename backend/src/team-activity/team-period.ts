import { BadRequestException } from '@nestjs/common';
import { businessDayOf, businessDayRange } from '../common/business-day';

// The date filter of Agent Activity and Team Performance. A preset is worked
// out in each business's own timezone, so "Today" for the Sydney business is
// Sydney's today even when the Main Account looks at it from India.

export const TEAM_PERIODS = ['today', 'yesterday', 'last7', 'last30', 'month', 'previous_month', 'custom'] as const;
export type TeamPeriod = (typeof TEAM_PERIODS)[number];

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** The longest custom range: a year and a day. */
const MAX_DAYS = 367;

/** "YYYY-MM-DD" moved by a number of days. */
export function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
}

/** The business days ("YYYY-MM-DD", both included) a period covers in one timezone. */
export function periodDays(period: TeamPeriod, timeZone: string, now: Date, custom: { from?: string; to?: string } = {}): { from: string; to: string } {
  const today = businessDayOf(timeZone, now);
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yesterday = shiftDay(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'last7':
      return { from: shiftDay(today, -6), to: today };
    case 'last30':
      return { from: shiftDay(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'previous_month': {
      const lastOfPrevious = shiftDay(`${today.slice(0, 8)}01`, -1);
      return { from: `${lastOfPrevious.slice(0, 8)}01`, to: lastOfPrevious };
    }
    case 'custom': {
      if (!custom.from || !YMD.test(custom.from)) throw new BadRequestException('Choose the first day of the range.');
      const to = custom.to && YMD.test(custom.to) ? custom.to : custom.from;
      if (to < custom.from) throw new BadRequestException('The last day is before the first day.');
      if (daysBetween(custom.from, to) > MAX_DAYS) throw new BadRequestException('Choose a range of a year or less.');
      return { from: custom.from, to };
    }
  }
}

export interface PeriodRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

/** The period as business days and as the half-open [start, end) instants that cover them. */
export function periodRange(period: TeamPeriod, timeZone: string, now: Date, custom: { from?: string; to?: string } = {}): PeriodRange {
  const days = periodDays(period, timeZone, now, custom);
  return { ...days, ...businessDayRange(timeZone, days.from, days.to) };
}
