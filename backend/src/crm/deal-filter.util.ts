import { FilterQuery, PipelineStage } from 'mongoose';
import { businessDayOf, DEFAULT_BUSINESS_TIMEZONE } from '../common/business-day';
import { currentDataSourceScope } from '../data-sources/data-source-context';
import { Deal } from './schemas/deal.schema';
import { DealFilterQueryDto } from './dto/deal-filter-query.dto';
import { HOOPS_SALESPERSON_PREFIX, isHoopsSalesperson, unlinkedHoopsSales } from './hoops-salespeople';

// ---- The day a deal counts on ---------------------------------------------------
//
// Revenue is a won deal's value in the month the deal was CLOSED: never the
// month it was created, nor the month it was once expected to close. A deal
// quoted in July and won on 16 November is November's revenue, whatever its
// expected closing date still says (a CRM such as Pantheras keeps the forecast
// it had, and HaiVE's sync re-reads it).
//
//  - Won or lost: the day of closedAt (deal.schema.ts: when it turned won or
//    lost, the CRM's own date when it gives one) in the business's own time
//    zone. A deal with no closedAt (closed before HaiVE recorded it on
//    21 Oct 2026, or first seen already closed) goes by its closing date
//    (expectedClosingDate), the only date known for it.
//  - Open: its expected closing date (the pipeline), as before.
//
// One definition for revenue and target, the revenue trend, won/lost counts,
// conversion, the leaderboards, Reporting and every drill-down list, so a
// figure and the list behind it always hold the same deals. Open and lost deals
// never add to revenue: every revenue sum also requires dealStatus 'won'.

/** Aggregation expression: the "YYYY-MM-DD" day a deal counts on ('' when it has none). */
export function countedDayExpr(timeZone: string): Record<string, unknown> {
  return {
    $cond: [
      { $and: [{ $in: ['$dealStatus', ['won', 'lost']] }, { $eq: [{ $type: '$closedAt' }, 'date'] }] },
      { $dateToString: { date: '$closedAt', format: '%Y-%m-%d', timezone: timeZone } },
      { $substrBytes: [{ $ifNull: ['$expectedClosingDate', ''] }, 0, 10] },
    ],
  };
}

/** Aggregation expression: the "YYYY-MM" month a deal counts in ('' when it has none). */
export function countedMonthExpr(timeZone: string): Record<string, unknown> {
  return { $substrBytes: [countedDayExpr(timeZone), 0, 7] };
}

/** Match condition: the deals that count in the months first..last ("YYYY-MM", both included). */
export function countedInMonths(first: string, last: string, timeZone: string): FilterQuery<Deal> {
  const month = countedMonthExpr(timeZone);
  return { $expr: { $and: [{ $gte: [month, first] }, { $lte: [month, last] }] } };
}

/** Match condition: the deals that count on the days from..to ("YYYY-MM-DD", both included). */
export function countedOnDays(from: string, to: string, timeZone: string): FilterQuery<Deal> {
  const day = countedDayExpr(timeZone);
  return { $expr: { $and: [{ $gte: [day, from] }, { $lte: [day, to] }] } };
}

/** countedDayExpr for a deal already read: the "YYYY-MM-DD" day it counts on, or undefined. */
export function countedDayOf(
  deal: { dealStatus?: string; closedAt?: Date | string | null; expectedClosingDate?: string | null },
  timeZone: string,
): string | undefined {
  if ((deal.dealStatus === 'won' || deal.dealStatus === 'lost') && deal.closedAt) {
    const at = new Date(deal.closedAt);
    if (!Number.isNaN(at.getTime())) return businessDayOf(timeZone, at);
  }
  return typeof deal.expectedClosingDate === 'string' && deal.expectedClosingDate ? deal.expectedClosingDate.slice(0, 10) : undefined;
}

// Two or more CRMs read together (the 'unified' selection; a dashboard
// normally reads one CRM): the same deal kept in both counts once. A copy is a
// deal with the same name, value, status and counted month in ANOTHER source;
// look-alike deals within one source are all real and all counted (each name
// keeps as many as its fullest source has). No stage at all for one source.
// `keep`: the fields the stages after it read.
export function sameDealOnceAcrossSources(timeZone: string, keep: string[]): PipelineStage[] {
  if ((currentDataSourceScope()?.sourceIds.length ?? 0) < 2) return [];
  const firstOf = Object.fromEntries(keep.map((field) => [field, { $first: `$${field}` }]));
  return [
    {
      $group: {
        _id: {
          name: { $toLower: { $trim: { input: { $ifNull: ['$name', ''] } } } },
          value: '$monetaryValue',
          status: '$dealStatus',
          month: countedMonthExpr(timeZone),
          source: '$dataSourceId',
        },
        copies: { $sum: 1 },
        ...firstOf,
      },
    },
    {
      $group: {
        _id: { name: '$_id.name', value: '$_id.value', status: '$_id.status', month: '$_id.month' },
        copies: { $max: '$copies' },
        ...firstOf,
      },
    },
    // Back to one document per deal, so the stages after it count as they would without this.
    { $set: { copy: { $range: [0, '$copies'] } } },
    { $unwind: '$copy' },
  ];
}

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
  // timeZone: the business's own (businessTimeZone) — the day a closed deal counts on depends on it.
  options?: { includeDateRange?: boolean; timeZone?: string },
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
  // filters.dateField 'expectedClosingDate' opts a caller into the dashboard's
  // period rule instead: the month each deal counts in (countedDayExpr above —
  // a won or lost deal by the day it closed, an open one by its expected
  // closing date). Every dashboard drill-down sends it, so the list behind
  // Revenue, Won Deals, the leaderboards… holds exactly the deals
  // SalesAnalyticsService.getAchievement and the overview counted. The value's
  // name predates closedAt and is kept so links and callers keep working.
  // Deliberately NOT a range against dateFrom/dateTo: MonthYearFilterPopup
  // caps dateTo at "today" for the current month (right for createdAt), but an
  // expected closing date can fall later in the month — so this is every
  // whole month the dates touch, from dateFrom's month to dateTo's
  // (countedMonths below — one month from the month picker, several from the
  // dashboard's Advanced start/end dates).
  if (includeDateRange && (filters.dateFrom || filters.dateTo)) {
    if (filters.dateField === 'expectedClosingDate') {
      const { first, last } = countedMonths((filters.dateFrom ?? filters.dateTo)!, (filters.dateTo ?? filters.dateFrom)!);
      Object.assign(match, countedInMonths(first, last, options?.timeZone ?? DEFAULT_BUSINESS_TIMEZONE));
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

  // Past their expected closing day (the past-due list, with dealStatus open).
  // "YYYY-MM-DD" strings compare correctly as text.
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


// The months a dashboard date range counts (by the day each deal counts on,
// countedDayExpr): every whole month it touches, from the start date's month
// to the end date's month (a range inside one month is that whole month).
// Whole months, not exact days, because the current month's range ends
// "today" while open deals' expected closing dates run to the month's end,
// and because sales targets are set per month. One definition for the dashboard overview (revenue, target, deals,
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

// Open deals expected to close in the months first..last ("YYYY-MM-DD"
// expectedClosingDate strings compare correctly as text). For anything that
// includes won or lost deals use countedInMonths.
export function expectedClosingMonthsMatch(first: string, last: string): Record<string, string> {
  return last > first ? { $gte: `${first}-01`, $lte: `${last}-31` } : { $regex: `^${first}` };
}
