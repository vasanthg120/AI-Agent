import { BillingCycle } from './schemas/billing-plan-price.schema';

export type RecurringBillingCycle = Exclude<BillingCycle, 'one_time'>;

// Shared by billing-subscriptions.service.ts (initial period) and
// subscription-renewal.service.ts (each renewal) — plain Date math, no date
// library dependency (this backend has none). setMonth/setFullYear/setDate
// correctly roll over month/year boundaries (e.g. Jan 31 + 1 month lands on
// the JS-native overflow date, same behavior every caller gets consistently
// since there's exactly one place this math happens).
export function addBillingCycle(start: Date, cycle: RecurringBillingCycle): Date {
  const next = new Date(start);
  switch (cycle) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
}
