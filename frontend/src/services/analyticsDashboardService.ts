import { axiosClient } from '@/api/axiosClient';

export interface AnalyticsScopeInfo {
  level: 'org' | 'store' | 'user';
  storeId?: string;
  storeName?: string;
  userId?: string;
}

export interface AiInsightItem {
  message: string;
  severity: 'critical' | 'warning' | 'info';
  actionTabId?: string;
  actionLabel?: string;
}

export interface AnalyticsDashboardOverview {
  dateFrom: string;
  dateTo: string;
  scope: AnalyticsScopeInfo;
  emailActivity: {
    totalRelevantCount: number;
    sentCount: number;
    missedCount: number;
    newEnquiryCount: number;
    byIntent: { intent: string; label: string; count: number }[];
  };
  deals: { wonCount: number; lostCount: number; openCount: number; wonValue: number; lostValue: number; openValue: number };
  revenue: {
    period: string;
    // The last month counted — the same as period for a single month.
    lastPeriod: string;
    targetAmount: number | null;
    currency: string;
    achieved: number;
    achievementPct: number | null;
    remaining: number | null;
    avgDailySalesNeeded: number | null;
    predictedMonthEnd: number;
    forecastConfidence: number;
    businessHealthScore: number | null;
  };
  // Won deals that started in the month before the selected one and were closed
  // in the selected one — shown beside `revenue`, never added to it (see the
  // backend's previous-month-closures.service.ts for the three dates).
  // Null when the period is more than one month (the band compares two single months).
  previousMonthClosures: PreviousMonthClosures | null;
  // Outstanding customer receivables (quoteAmount - paidAmount, summed) —
  // "dues" in Agent Activity's team-wide view. Not date-range scoped, unlike
  // the rest of this response — a current balance, not a per-period figure.
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
  insights: AiInsightItem[];
}

export interface PreviousMonthClosedDeal {
  id: string;
  name: string;
  value: number;
  // "YYYY-MM-DD": the earliest date the deal or one of its quotes was recorded.
  startedOn: string;
  startedFrom: 'deal' | 'quote';
  // "YYYY-MM-DD": recorded when it turned won, or its closing date for deals closed before that was recorded.
  closedOn: string;
  closedFrom: 'recorded' | 'closing-date';
  // "YYYY-MM" of its closing date — the month its revenue counts in (null: none).
  revenuePeriod: string | null;
}

export interface PreviousMonthClosures {
  period: string;
  previousPeriod: string;
  count: number;
  value: number;
  inThisMonthRevenue: { count: number; value: number };
  outsideThisMonthRevenue: { count: number; value: number };
  // Won deals closed in the month whose start is unknown — not in the count above.
  unknownStart: { count: number; value: number };
  deals: PreviousMonthClosedDeal[];
}

// The open pipeline of every month at once (not scoped to the dashboard's chosen month).
export interface PipelineByMonth {
  scope: { level: 'org' | 'store' | 'user'; storeId?: string; storeName?: string; userId?: string };
  // Every open deal in scope, dated or not.
  totalCount: number;
  totalValue: number;
  // Oldest first, from the earliest to the latest month that has an open deal; a month between them with none is there at zero.
  months: { period: string; count: number; value: number }[];
  // Open deals with no expected closing date: in the total, in no month.
  undated: { count: number; value: number };
}

// Pipeline Health for the period (backend PipelineHealth): the deals expected
// to close in its months, the open ones split by whether their closing date
// has passed. One aggregate, shared by the Pipeline & Quotes card and the
// Overview's Pipeline box.
export interface PipelineHealth {
  period: { first: string; last: string };
  today: string;
  open: { count: number; value: number };
  onTime: { count: number; value: number };
  pastDue: { count: number; value: number };
  won: { count: number; value: number };
  lost: { count: number; value: number };
  winRatePct: number | null;
}

export const analyticsDashboardService = {
  async getPipelineHealth(dateFrom: string, dateTo: string, today: string, storeId?: string): Promise<PipelineHealth> {
    const { data } = await axiosClient.get<PipelineHealth>('/analytics-dashboard/pipeline-health', {
      params: { dateFrom, dateTo, today, ...(storeId ? { storeId } : {}) },
    });
    return data;
  },

  async getPipelineByMonth(storeId?: string): Promise<PipelineByMonth> {
    const { data } = await axiosClient.get<PipelineByMonth>('/analytics-dashboard/pipeline-by-month', {
      params: storeId ? { storeId } : undefined,
    });
    return data;
  },

  async getOverview(
    dateFrom: string,
    dateTo: string,
    storeId?: string,
    // Agent Activity's drill-down (admin/owner only, viewing one specific
    // user) and team-wide view (every admin-created user, not just
    // manager/consultant) — see backend/src/analytics-dashboard's own
    // comments on these two params.
    userId?: string,
    includeAllUsers?: boolean,
  ): Promise<AnalyticsDashboardOverview> {
    const { data } = await axiosClient.get<AnalyticsDashboardOverview>('/analytics-dashboard/overview', {
      params: {
        dateFrom,
        dateTo,
        ...(storeId ? { storeId } : {}),
        ...(userId ? { userId } : {}),
        ...(includeAllUsers ? { includeAllUsers: true } : {}),
      },
    });
    return data;
  },
};
