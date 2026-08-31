import { adminAxiosClient } from '@/api/adminAxiosClient';

// Haive-internal only — every method here hits a @Roles('platform_admin')
// route (backend/src/billing/billing-admin.controller.ts). Never called
// from any customer-facing page; only from features/platform-admin and
// features/admin-haive.
export interface AdminOverview {
  days: number;
  revenueUsd: number;
  providerCostUsd: number;
  grossProfitUsd: number;
  realizedMarginPct: number;
  creditsSold: number;
  creditsUsed: number;
  totalAiRequests: number;
  refundedUsd: number;
  refundsCount: number;
  failedPaymentsCount: number;
  totalCustomers: number;
}

export interface AdminDashboard {
  days: number;
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  activeSubscriptions: number;
  revenueUsd: number;
  successfulPaymentsCount: number;
  failedPaymentsCount: number;
  refundedPaymentsCount: number;
  creditsSold: number;
  creditsUsed: number;
  creditsOutstanding: number;
  autoRechargeEnabledWallets: number;
  autoRechargeEventsInPeriod: number;
}

export interface AnalyticsSeriesPoint {
  date: string;
  value: number;
}

export interface AdminAnalytics {
  days: number;
  revenueSeries: AnalyticsSeriesPoint[];
  creditUsageSeries: AnalyticsSeriesPoint[];
  newOrganizationsSeries: AnalyticsSeriesPoint[];
  subscriptionGrowthSeries: AnalyticsSeriesPoint[];
  paymentSuccessSeries: AnalyticsSeriesPoint[];
  paymentFailureSeries: AnalyticsSeriesPoint[];
  planDistribution: { planName: string; count: number }[];
}

export interface SubscriptionMetrics {
  days: number;
  mrrUsd: number;
  arrUsd: number;
  activeCount: number;
  trialingCount: number;
  pastDueCount: number;
  canceledCount: number;
  expiredCount: number;
  newSubscriptionsInPeriod: number;
  canceledInPeriod: number;
  churnRatePct: number;
}

export interface OrganizationBilling {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  userCount: number;
  planName: string | null;
  subscriptionStatus: string | null;
  walletBalanceCredits: number;
  creditsUsed: number;
  revenueUsd: number;
  providerCostUsd: number;
  grossProfitUsd: number;
  totalRequests: number;
  createdAt: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminSubscriptionSummary {
  id: string;
  organizationId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: { id: string; key: string; name: string } | null;
  price: { id: string; currencyCode: string; billingCycle: string; amount: number } | null;
}

export interface AdminWalletRow {
  organizationId: string;
  organizationName: string;
  walletId: string;
  balanceCredits: number;
  reservedCredits: number;
  availableCredits: number;
  autoPayEnabled: boolean;
}

export interface OrganizationDetail {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  createdAt: string;
  userCount: number;
  wallet: {
    balanceCredits: number;
    reservedCredits: number;
    availableCredits: number;
    lowBalanceThresholdCredits: number;
    lowBalance: boolean;
    autoPay: { enabled: boolean; thresholdCredits: number; rechargeAmountCredits: number };
  };
  subscription: AdminSubscriptionSummary | null;
  lifetimeRevenueUsd: number;
  lifetimeCreditsUsed: number;
}

export interface AdminWalletTransaction {
  _id: string;
  organizationId: string;
  type: string;
  amountCredits: number;
  balanceAfterCredits: number;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export interface AdminInvoiceItem {
  description: string;
  quantity: number;
  unitAmount: number;
  total: number;
}

export interface AdminInvoice {
  _id: string;
  organizationId: string;
  invoiceNumber: string;
  type: 'purchase' | 'autopay' | 'subscription_checkout' | 'subscription_renewal';
  paymentRecordId: string;
  subscriptionId?: string;
  status: 'paid' | 'void';
  currencyCode: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  items: AdminInvoiceItem[];
  issuedAt: string;
  paidAt?: string;
  voidedAt?: string;
  voidReason?: string;
}

export interface AdminRefund {
  _id: string;
  organizationId: string;
  paymentRecordId: string;
  provider: 'razorpay' | 'stripe' | 'cashfree';
  gatewayRefundId?: string;
  amount: number;
  currency: string;
  creditsClawedBack: number;
  reason?: string;
  status: 'succeeded' | 'failed';
  simulated: boolean;
  createdAt: string;
}

export interface AdminPaymentRecord {
  _id: string;
  organizationId: string;
  type: 'purchase' | 'autopay' | 'subscription_checkout' | 'subscription_renewal';
  provider: 'razorpay' | 'stripe' | 'cashfree';
  gatewayOrderId: string;
  gatewayPaymentId?: string;
  amount: number;
  currency: string;
  creditsGranted: number;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  simulated: boolean;
  refundedAmount?: number;
  createdAt: string;
}

export const billingAdminService = {
  async getOverview(days?: number): Promise<AdminOverview> {
    const { data } = await adminAxiosClient.get<AdminOverview>('/billing/admin/overview', { params: { days } });
    return data;
  },

  async getDashboard(days?: number): Promise<AdminDashboard> {
    const { data } = await adminAxiosClient.get<AdminDashboard>('/billing/admin/dashboard', { params: { days } });
    return data;
  },

  async getAnalytics(days?: number): Promise<AdminAnalytics> {
    const { data } = await adminAxiosClient.get<AdminAnalytics>('/billing/admin/analytics', { params: { days } });
    return data;
  },

  async getSubscriptionMetrics(days?: number): Promise<SubscriptionMetrics> {
    const { data } = await adminAxiosClient.get<SubscriptionMetrics>('/billing/admin/subscription-metrics', { params: { days } });
    return data;
  },

  async getOrganizations(days?: number): Promise<OrganizationBilling[]> {
    const { data } = await adminAxiosClient.get<OrganizationBilling[]>('/billing/admin/organizations', { params: { days } });
    return data;
  },

  async getOrganizationsPage(params: {
    days?: number;
    page: number;
    limit?: number;
    search?: string;
    sortBy?: 'name' | 'createdAt' | 'revenueUsd' | 'userCount';
  }): Promise<PagedResult<OrganizationBilling>> {
    const { data } = await adminAxiosClient.get<PagedResult<OrganizationBilling>>('/billing/admin/organizations', { params });
    return data;
  },

  async getOrganizationDetail(organizationId: string): Promise<OrganizationDetail> {
    const { data } = await adminAxiosClient.get<OrganizationDetail>(`/billing/admin/organizations/${organizationId}`);
    return data;
  },

  async getOrganizationUsers(organizationId: string) {
    const { data } = await adminAxiosClient.get(`/billing/admin/organizations/${organizationId}/users`);
    return data;
  },

  async listWallets(params?: { search?: string; page?: number; limit?: number }): Promise<PagedResult<AdminWalletRow>> {
    const { data } = await adminAxiosClient.get<PagedResult<AdminWalletRow>>('/billing/admin/wallets', { params });
    return data;
  },

  async listTransactions(params?: {
    organizationId?: string;
    type?: string;
    limit?: number;
    skip?: number;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
  }): Promise<AdminWalletTransaction[]> {
    const { data } = await adminAxiosClient.get<AdminWalletTransaction[]>('/billing/admin/transactions', { params });
    return data;
  },

  async listPayments(params?: {
    organizationId?: string;
    status?: string;
    provider?: string;
    limit?: number;
    skip?: number;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<AdminPaymentRecord[]> {
    const { data } = await adminAxiosClient.get<AdminPaymentRecord[]>('/billing/admin/payments', { params });
    return data;
  },

  async listSubscriptions(params?: {
    organizationId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PagedResult<AdminSubscriptionSummary>> {
    const { data } = await adminAxiosClient.get<PagedResult<AdminSubscriptionSummary>>('/billing/admin/subscriptions', { params });
    return data;
  },

  async cancelSubscription(id: string): Promise<AdminSubscriptionSummary> {
    const { data } = await adminAxiosClient.post<AdminSubscriptionSummary>(`/billing/admin/subscriptions/${id}/cancel`);
    return data;
  },

  async reactivateSubscription(id: string): Promise<AdminSubscriptionSummary> {
    const { data } = await adminAxiosClient.post<AdminSubscriptionSummary>(`/billing/admin/subscriptions/${id}/reactivate`);
    return data;
  },

  async listInvoices(params?: { organizationId?: string; status?: string; limit?: number }): Promise<AdminInvoice[]> {
    const { data } = await adminAxiosClient.get<AdminInvoice[]>('/billing/admin/invoices', { params });
    return data;
  },

  async voidInvoice(id: string, reason?: string): Promise<AdminInvoice> {
    const { data } = await adminAxiosClient.post<AdminInvoice>(`/billing/admin/invoices/${id}/void`, { reason });
    return data;
  },

  // Same authenticated blob-download pattern as royaltyReportService.downloadExport
  // — a plain <a href> can't carry the bearer token this route requires.
  async downloadInvoice(id: string, invoiceNumber: string, format: 'pdf' | 'csv'): Promise<void> {
    const response = await adminAxiosClient.get(`/billing/admin/invoices/${id}/${format}`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invoiceNumber}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async listRefunds(params?: { organizationId?: string; paymentRecordId?: string; limit?: number }): Promise<AdminRefund[]> {
    const { data } = await adminAxiosClient.get<AdminRefund[]>('/billing/admin/refunds', { params });
    return data;
  },

  async createRefund(dto: { paymentRecordId: string; amount?: number; reason?: string }): Promise<AdminRefund> {
    const { data } = await adminAxiosClient.post<AdminRefund>('/billing/admin/refunds', dto);
    return data;
  },
};
