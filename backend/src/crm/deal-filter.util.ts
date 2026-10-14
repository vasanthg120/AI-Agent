import { FilterQuery } from 'mongoose';
import { Deal } from './schemas/deal.schema';
import { DealFilterQueryDto } from './dto/deal-filter-query.dto';

// Single place the Mongo match stage gets built from a DealFilterQueryDto —
// reused by deals.service.ts's listFiltered/listForExport and
// deal-performance-dashboard.service.ts's aggregations, so filter semantics
// can never drift between the list/export/dashboard paths.
//
// `includeDateRange: false` is used by trend widgets that generate their
// own date-bucketed axis (e.g. wonLostTrend) — those apply their own period
// window on top of this match rather than the user's dateFrom/dateTo.
export function buildDealMatchStage(
  organizationId: string,
  filters: DealFilterQueryDto,
  storeConstraint?: string,
  options?: { includeDateRange?: boolean },
): FilterQuery<Deal> {
  const includeDateRange = options?.includeDateRange ?? true;
  const match: FilterQuery<Deal> = { organizationId };

  // Escaped before use (same precedent as royalty/invoice-filter.util.ts's
  // customerName search) — a raw, unescaped user string straight into
  // $regex would let stray regex metacharacters throw or scan pathologically.
  if (filters.search?.trim()) {
    const escaped = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match.name = new RegExp(escaped, 'i');
  }

  if (storeConstraint) {
    match.storeId = storeConstraint;
  } else if (filters.storeId?.length) {
    match.storeId = { $in: filters.storeId };
  }

  if (filters.ownerId?.length) match.ownerId = { $in: filters.ownerId };
  if (filters.dealStatus?.length) match.dealStatus = { $in: filters.dealStatus };
  if (filters.stageId?.length) match.stageId = { $in: filters.stageId };
  if (filters.leadSource?.length) match.leadSource = { $in: filters.leadSource };
  if (filters.product?.length) match.product = { $in: filters.product };
  if (filters.customerType?.length) match.customerType = { $in: filters.customerType };
  if (filters.region?.length) match.region = { $in: filters.region };

  // Real user-reported bug, fixed here: was expectedClosingDate (a forecast
  // field — "when will this revenue land"), which made a deal created today
  // with a next-month expected close date invisible to a "this month"
  // filter — reads as broken, not as intended forecast behavior. Filters
  // on createdAt instead — "did I create/touch this record in this
  // window" — matching Quote's own equivalent filtering, which was already
  // correctly createdAt-based. dateFrom/dateTo are plain "YYYY-MM-DD"
  // strings; dateTo is pushed to end-of-day so a date-only value doesn't
  // mean midnight and silently exclude that entire day's own records.
  //
  // filters.dateField opts a caller into expectedClosingDate instead —
  // needed by callers reconciling against SalesAnalyticsService.getAchievement,
  // which sums won deals by expectedClosingDate's own YYYY-MM prefix, not
  // createdAt. Deliberately NOT a $gte/$lte range against dateFrom/dateTo:
  // MonthYearFilterPopup caps dateTo at "today" for the current month
  // (rangeForMonth — correct for createdAt, which can't be in the future),
  // but expectedClosingDate is a forecast field that can legitimately fall
  // later in the month than today. Ranging against the capped dateTo would
  // silently exclude those deals from the drill-down while getAchievement's
  // own regex still counts them — so this matches getAchievement exactly:
  // the whole calendar month of dateFrom, via the same YYYY-MM prefix regex,
  // ignoring dateTo entirely. dateFrom is always the 1st of that month here
  // (every caller of dateField:'expectedClosingDate' sources it from
  // MonthYearFilterPopup/defaultRange, both always whole-month-start).
  if (includeDateRange && (filters.dateFrom || filters.dateTo)) {
    if (filters.dateField === 'expectedClosingDate') {
      const period = (filters.dateFrom ?? filters.dateTo)!.slice(0, 7);
      const lastPeriod = (filters.dateTo ?? filters.dateFrom)!.slice(0, 7);
      // A range inside one month is that whole month (as described above). A
      // range across several months — "last 90 days", a quarter — is every
      // whole month it touches; it used to count the first month only, so a
      // longer range could show FEWER deals than a shorter one. The dates are
      // "YYYY-MM-DD" strings, which compare correctly as text.
      match.expectedClosingDate = lastPeriod > period ? { $gte: `${period}-01`, $lte: `${lastPeriod}-31` } : { $regex: `^${period}` };
    } else {
      // Explicit 'Z' (UTC) end-of-day, not `.setHours(23,59,59,999)` — that
      // mutates in the server process's LOCAL timezone, so on any server not
      // running in UTC it lands hours away from analytics-dashboard.service.ts's
      // own `${dateTo}T23:59:59.999Z` boundary (used to compute wonValue/
      // lostValue). That mismatch silently dropped deals created late in the
      // last day of range from this list while the dashboard's own total
      // still counted them — real user-reported bug (Won/Lost Revenue bar's
      // drill-down popup missing deals the bar's own dollar total included).
      match.createdAt = {
        ...(filters.dateFrom ? { $gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}),
        ...(filters.dateTo ? { $lte: new Date(`${filters.dateTo}T23:59:59.999Z`) } : {}),
      };
    }
  }

  if (filters.valueMin !== undefined || filters.valueMax !== undefined) {
    match.monetaryValue = {
      ...(filters.valueMin !== undefined ? { $gte: filters.valueMin } : {}),
      ...(filters.valueMax !== undefined ? { $lte: filters.valueMax } : {}),
    };
  }

  return match;
}
