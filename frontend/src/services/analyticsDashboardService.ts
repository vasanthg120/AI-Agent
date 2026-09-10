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

export const analyticsDashboardService = {
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
