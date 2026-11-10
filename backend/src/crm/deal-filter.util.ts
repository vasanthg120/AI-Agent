import { FilterQuery } from 'mongoose';
import { Deal } from './schemas/deal.schema';
import { DealFilterQueryDto } from './dto/deal-filter-query.dto';
import { HOOPS_SALESPERSON_PREFIX, isHoopsSalesperson, unlinkedHoopsSales } from './hoops-salespeople';

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

  if (filters.ownerId?.length) {
    // A Hoops salesperson without a HaiVE login is "hoops:<their Hoops id>" (see hoops-salespeople.ts).
    const hoops = filters.ownerId.filter(isHoopsSalesperson).map((id) => id.slice(HOOPS_SALESPERSON_PREFIX.length));
    if (hoops.length === 0) {
      match.ownerId = { $in: filters.ownerId };
    } else {
      const users = filters.ownerId.filter((id) => !isHoopsSalesperson(id));
      match.$or = [...(users.length ? [{ ownerId: { $in: users } }] : []), unlinkedHoopsSales(hoops)];
    }
  }
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
  // every whole month the dates touch, from dateFrom's month to dateTo's
  // (countedMonths below — one month from the month picker, several from the
  // dashboard's Advanced start/end dates).
  if (includeDateRange && (filters.dateFrom || filters.dateTo)) {
    if (filters.dateField === 'expectedClosingDate') {
      const { first, last } = countedMonths((filters.dateFrom ?? filters.dateTo)!, (filters.dateTo ?? filters.dateFrom)!);
      match.expectedClosingDate = expectedClosingMonthsMatch(first, last);
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

  // Past their expected closing day (the past-due list). Added to any
  // expectedClosingDate condition above — MongoDB takes several operators on
  // one field — and "YYYY-MM-DD" strings compare correctly as text.
  if (filters.closingBefore) {
    const existing = match.expectedClosingDate as Record<string, unknown> | undefined;
    match.expectedClosingDate = { ...(existing ?? {}), $lt: filters.closingBefore };
  }

  if (filters.valueMin !== undefined || filters.valueMax !== undefined) {
    match.monetaryValue = {
      ...(filters.valueMin !== undefined ? { $gte: filters.valueMin } : {}),
      ...(filters.valueMax !== undefined ? { $lte: filters.valueMax } : {}),
    };
  }

  return match;
}


// The months a dashboard date range counts, by expected closing date: every
// whole month it touches, from the start date's month to the end date's month
// (a range inside one month is that whole month). Whole months, not exact
// days, because the current month's range ends "today" while its expected
// closing dates run to the month's end, and because sales targets are set per
// month. One definition for the dashboard overview (revenue, target, deals,
// conversion), SalesAnalyticsService.getAchievement and every deal list, so a
// figure and the list behind it always cover the same deals. An end before
// the start counts the start month only.
export function countedMonths(dateFrom: string, dateTo: string): { first: string; last: string; months: string[] } {
  const first = dateFrom.slice(0, 7);
  const last = dateTo.slice(0, 7) > first ? dateTo.slice(0, 7) : first;
  const months: string[] = [];
  let [year, month] = first.split('-').map(Number);
  for (let period = first; period <= last; ) {
    months.push(period);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    period = `${year}-${String(month).padStart(2, '0')}`;
  }
  return { first, last, months };
}

// "YYYY-MM-DD" expectedClosingDate strings compare correctly as text.
export function expectedClosingMonthsMatch(first: string, last: string): Record<string, string> {
  return last > first ? { $gte: `${first}-01`, $lte: `${last}-31` } : { $regex: `^${first}` };
}
