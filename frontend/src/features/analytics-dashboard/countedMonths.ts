import dayjs from 'dayjs';

// The months the dashboard counts for a date range: every whole month the
// dates touch, from the start date's month to the end date's month (a range
// inside one month is that whole month). Mirrors countedMonths in the
// backend's crm/deal-filter.util.ts, which revenue, targets, deals, conversion
// and every deal list use, so labels name exactly what the figures cover.
export interface CountedMonths {
  /** "YYYY-MM" */
  first: string;
  /** "YYYY-MM" — the same as first for a single month. */
  last: string;
  count: number;
  /** "Nov 2026", "May – Nov 2026", "Dec 2025 – Feb 2026" */
  label: string;
}

export function countedMonths(dateFrom: string, dateTo: string): CountedMonths {
  const first = dayjs(dateFrom).startOf('month');
  const end = dayjs(dateTo).startOf('month');
  const last = end.isBefore(first) ? first : end;
  const count = last.diff(first, 'month') + 1;
  const label =
    count === 1
      ? first.format('MMM YYYY')
      : first.year() === last.year()
        ? `${first.format('MMM')} – ${last.format('MMM YYYY')}`
        : `${first.format('MMM YYYY')} – ${last.format('MMM YYYY')}`;
  return { first: first.format('YYYY-MM'), last: last.format('YYYY-MM'), count, label };
}
