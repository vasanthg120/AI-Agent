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

export interface PipelineMonth {
  /** "YYYY-MM": the month the deals are expected to close in. */
  period: string;
  count: number;
  value: number;
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
