import { Achievement } from '../crm/sales-analytics.service';

export interface ScopeInfo {
  level: 'org' | 'store' | 'user';
  storeId?: string;
  storeName?: string;
  userId?: string;
}

// One deterministic, rule-based observation from buildInsights() — never an
// LLM call (see that method's own comment). actionTabId, when present, is
// one of AnalyticsDashboardPage's own TAB_ITEMS ids; the frontend never
// navigates anywhere new for it, just switches the already-open dashboard to
// that tab.
export interface AiInsightItem {
  message: string;
  severity: 'critical' | 'warning' | 'info';
  actionTabId?: string;
  actionLabel?: string;
}

export interface AnalyticsDashboardOverview {
  dateFrom: string;
  dateTo: string;
  scope: ScopeInfo;
  emailActivity: {
    totalRelevantCount: number;
    sentCount: number;
    missedCount: number;
    newEnquiryCount: number;
    byIntent: { intent: string; label: string; receivedCount: number; sentCount: number }[];
  };
  deals: { wonCount: number; lostCount: number; openCount: number; wonValue: number; lostValue: number; openValue: number };
  revenue: Achievement & { businessHealthScore: number | null };
  // Shown beside `revenue`, never added to it or to the target, forecast or run rate.
  // Null when the period is more than one month (the band compares two single months).
  previousMonthClosures: PreviousMonthClosures | null;
  // Outstanding customer receivables (quoteAmount - paidAmount, summed) —
  // "dues" in Agent Activity's team-wide view. Not date-range scoped, unlike
  // the rest of this response (see QuotesService.getOutstandingByOwner) —
  // this is a current balance, not a per-period figure.
  outstanding: { total: number };
  employeeLeaderboard: { userId: string; userName: string; revenue: number; wonCount: number; pipelineValue: number; outstanding: number }[];
  workBreakdown: {
    userId: string;
    userName: string;
    wonCount: number;
    lostCount: number;
    openCount: number;
    conversionRate: number | null;
    pipelineValue: number;
    outstanding: number;
  }[];
  quotes: { acceptedCount: number; acceptedValue: number; notAcceptedCount: number; notAcceptedValue: number };
  revenueTrend: { period: string; achieved: number; targetAmount: number | null; achievementPct: number | null }[];
  customers: { newCount: number; existingCount: number; lostCount: number; totalConsidered: number };
  aiInsight: string;
  // Additive — aiInsight above is untouched (kept in case anything else
  // depends on the single-string shape). insights is the richer replacement
  // the redesigned Overview tab actually renders: every applicable
  // observation, not just the first match.
  insights: AiInsightItem[];
}

// Won deals that started in the month before the selected one and were closed
// in the selected one. Three dates are kept apart (previous-month-closures.service.ts):
// when a deal started, when it was closed, and the month its revenue counts in.
export interface PreviousMonthClosedDeal {
  id: string;
  name: string;
  value: number;
  /** "YYYY-MM-DD": the earliest date the deal or one of its quotes was recorded in the CRM or HaiVE. */
  startedOn: string;
  startedFrom: 'deal' | 'quote';
  /** "YYYY-MM-DD": when it was closed — recorded when it turned won, or (for deals closed before that was recorded) its closing date. */
  closedOn: string;
  closedFrom: 'recorded' | 'closing-date';
  /** "YYYY-MM" of its closing date — the month its revenue counts in; null when it has no closing date (then it counts in no month). */
  revenuePeriod: string | null;
}

export interface PreviousMonthClosures {
  /** "YYYY-MM": the selected month — the deals were closed in it. */
  period: string;
  /** "YYYY-MM": the month before it — the deals started in it. */
  previousPeriod: string;
  count: number;
  value: number;
  /** Of those, the ones already inside the selected month's revenue (their closing date is in it). */
  inThisMonthRevenue: { count: number; value: number };
  /** Of those, the ones whose closing date puts their revenue in another month (or none). */
  outsideThisMonthRevenue: { count: number; value: number };
  /** Won deals closed in the selected month whose start is unknown — not counted above. */
  unknownStart: { count: number; value: number };
  /** Highest value first. */
  deals: PreviousMonthClosedDeal[];
}

export interface PipelineMonth {
  /** "YYYY-MM": the month the deals are expected to close in. */
  period: string;
  count: number;
  value: number;
}

// Pipeline Health (Pipeline & Quotes tab, and the Overview's Pipeline box):
// the deals expected to close in the period's months (countedMonths), by
// status, with the open ones split by whether their closing date has passed.
// One aggregate — before 2026-11-10 the card read the first 100 open deals in
// the browser (so a bigger pipeline under-counted what was past due) and
// headlined "total outstanding": every quote in the period minus payments,
// which, with no payments recorded, was simply everything ever quoted.
export interface PipelineHealth {
  period: { first: string; last: string };
  /** "YYYY-MM-DD": open deals expected to close before this day are past due. */
  today: string;
  open: { count: number; value: number };
  onTime: { count: number; value: number };
  pastDue: { count: number; value: number };
  won: { count: number; value: number };
  lost: { count: number; value: number };
  /** won ÷ (won + lost), one decimal; null with nothing closed. */
  winRatePct: number | null;
}

// The open pipeline of every month at once. The rest of the dashboard follows
// the one month chosen at the top; this is what stays open whichever month it
// was expected to close in — so it is deliberately not date-scoped.
export interface PipelineByMonth {
  scope: ScopeInfo;
  /** Every open deal in scope, dated or not. */
  totalCount: number;
  totalValue: number;
  /** One entry per month, oldest first, from the earliest to the latest month that has an open deal; a month between them with none is included at zero. */
  months: PipelineMonth[];
  /** Open deals with no expected closing date: in the total, in no month. */
  undated: { count: number; value: number };
}
