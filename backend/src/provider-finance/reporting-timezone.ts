// Haive's own operating timezone for platform-wide finance reporting
// boundaries ("this month", "today") — Asia/Kolkata, the same timezone this
// codebase's own org defaults/seeds/e2e fixtures already assume (+91 phone
// codes, INR currency, 'Asia/Kolkata' literal — see sub-accounts.e2e.spec.ts,
// email-sla-calculator.spec.ts). Provider Finance is platform-wide (no
// organizationId, no per-org timezone to read), so this is a fixed constant
// rather than a per-request lookup.
//
// Fixed because Asia/Kolkata has no DST — a correctness bug this module
// previously had used `new Date(y, m, 1)` (the SERVER's OS-local timezone)
// for month/day boundaries while MongoDB's own date aggregations defaulted
// to UTC grouping. On a server actually running in IST (confirmed: this
// deployment's Intl.DateTimeFormat().resolvedOptions().timeZone is
// "Asia/Calcutta"), a transaction just after local midnight but before UTC
// midnight (any time before 5:30am IST) got silently bucketed into the
// PREVIOUS UTC calendar day — e.g. a report dashboard showing "November"
// while its own daily chart showed "October" dates for the same data. Using
// this one fixed offset everywhere (both in JS date math AND as the
// `timezone` option passed to MongoDB's $dateToString/$dateToParts, which
// accepts IANA names directly) makes every boundary agree, independent of
// whatever OS timezone a given deployment's Node process happens to run in.
export const REPORTING_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Midnight on the 1st of the current month, Asia/Kolkata wall-clock time —
 * returned as the real UTC instant that represents, so it drops straight
 * into any `occurredAt: { $gte: ... }` Mongo query unchanged. */
export function startOfMonthIst(now: Date = new Date()): Date {
  const istWallClock = new Date(now.getTime() + IST_OFFSET_MS);
  const istMonthStartWallClock = new Date(Date.UTC(istWallClock.getUTCFullYear(), istWallClock.getUTCMonth(), 1));
  return new Date(istMonthStartWallClock.getTime() - IST_OFFSET_MS);
}

/** Midnight today, Asia/Kolkata wall-clock time — same reasoning as
 * startOfMonthIst, for "today"-scoped checks (e.g. the spend-spike alert). */
export function startOfDayIst(now: Date = new Date()): Date {
  const istWallClock = new Date(now.getTime() + IST_OFFSET_MS);
  const istDayStartWallClock = new Date(Date.UTC(istWallClock.getUTCFullYear(), istWallClock.getUTCMonth(), istWallClock.getUTCDate()));
  return new Date(istDayStartWallClock.getTime() - IST_OFFSET_MS);
}
