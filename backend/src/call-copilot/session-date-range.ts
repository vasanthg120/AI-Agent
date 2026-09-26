// A bare calendar date ("2026-09-25") names a whole day. As the *upper* bound of
// a range that has to mean the end of that day: `new Date('2026-09-25')` is the
// day's first instant, so `createdAt <= dateTo` on a same-day range (Today)
// matched nothing at all, and any longer range dropped its last day. Same
// end-of-day-in-UTC rule the rest of the backend uses for `dateTo` (see
// crm/deal-filter.util.ts). A full timestamp is taken exactly as given — the web
// app sends the viewer's own local day boundaries that way.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function sessionRangeStart(dateFrom: string): Date {
  return new Date(dateFrom);
}

export function sessionRangeEnd(dateTo: string): Date {
  return DATE_ONLY.test(dateTo) ? new Date(`${dateTo}T23:59:59.999Z`) : new Date(dateTo);
}
