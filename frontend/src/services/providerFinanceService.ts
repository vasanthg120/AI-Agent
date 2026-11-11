import { adminAxiosClient } from '@/api/adminAxiosClient';

// Platform expenditure/balance/payment tracking for LLM providers — see
// backend/src/provider-finance/provider-finance.service.ts's own class
// comment for why confirmedBalance is manual-only (neither Anthropic nor
// Groq expose a real balance-check API) and estimatedBalance is always
// derived, never stored.

export type FinanceProvider = 'anthropic' | 'groq';

export interface ProviderAccountView {
  provider: string;
  accountIdentifier: string | null;
  status: 'active' | 'degraded' | 'exhausted' | 'unknown';
  accountType: 'prepaid' | 'postpaid' | 'usage-limited' | 'balance-unavailable';
  currency: string;
  confirmedBalance: number | null;
  estimatedBalance: number | null;
  lastReconciledAt: string | null;
  lastReconciledByAdminId: string | null;
  monthlyBudget: number | null;
  lowThresholdPct: number;
  criticalThresholdPct: number;
  zeroBalanceAction: 'alert-only' | 'mark-unavailable';
  alertRecipients: string[];
}

export interface ProviderPaymentRow {
  _id: string;
  provider: string;
  amount: number;
  currency: string;
  paymentDate: string;
  paymentMethod: string;
  transactionId?: string;
  invoiceNumber?: string;
  creditPurchased?: number;
  taxAmount?: number;
  feeAmount?: number;
  receiptFileId?: string;
  receiptFileName?: string;
  status: 'recorded' | 'confirmed' | 'disputed';
  recordedByAdminId: string;
  notes?: string;
}

export interface FinanceDashboard {
  days: number;
  totalExpenditureThisYear: number;
  totalPaymentsInRange: number;
  totalConsumptionThisMonth: number;
  activeProviderCount: number;
  lowBalanceProviderCount: number;
  exhaustedProviderCount: number;
  lastPaymentDate: string | null;
  nextExpectedRechargeDateEstimate: string | null;
  accounts: ProviderAccountView[];
}

export interface Profitability {
  days: number;
  totalRevenueCredits: number;
  totalProviderCostUsd: number;
  providerCostBreakdown: { provider: string; costUsd: number }[];
  dailyRevenueSeries: { date: string; revenueCredits: number }[];
}

export interface RecordPaymentPayload {
  provider: string;
  amount: number;
  currency?: string;
  paymentDate: string;
  paymentMethod: string;
  transactionId?: string;
  invoiceNumber?: string;
  creditPurchased?: number;
  taxAmount?: number;
  feeAmount?: number;
  status?: 'recorded' | 'confirmed' | 'disputed';
  notes?: string;
}

export const providerFinanceService = {
  async getDashboard(days: number): Promise<FinanceDashboard> {
    const { data } = await adminAxiosClient.get<FinanceDashboard>('/provider-finance/admin/dashboard', { params: { days } });
    return data;
  },

  async getProfitability(days: number): Promise<Profitability> {
    const { data } = await adminAxiosClient.get<Profitability>('/provider-finance/admin/profitability', { params: { days } });
    return data;
  },

  async getAccounts(): Promise<ProviderAccountView[]> {
    const { data } = await adminAxiosClient.get<ProviderAccountView[]>('/provider-finance/admin/accounts');
    return data;
  },

  async upsertAccount(provider: string, patch: Partial<ProviderAccountView>): Promise<ProviderAccountView> {
    const { data } = await adminAxiosClient.patch<ProviderAccountView>(`/provider-finance/admin/accounts/${provider}`, patch);
    return data;
  },

  async reconcile(provider: string, confirmedBalance: number): Promise<ProviderAccountView> {
    const { data } = await adminAxiosClient.post<ProviderAccountView>(`/provider-finance/admin/accounts/${provider}/reconcile`, { confirmedBalance });
    return data;
  },

  async listPayments(filters: { provider?: string; dateFrom?: string; dateTo?: string; status?: string; currency?: string; page: number; pageSize: number }) {
    const { data } = await adminAxiosClient.get<{ items: ProviderPaymentRow[]; total: number; page: number; pageSize: number }>('/provider-finance/admin/payments', { params: filters });
    return data;
  },

  async recordPayment(payload: RecordPaymentPayload): Promise<ProviderPaymentRow> {
    const { data } = await adminAxiosClient.post<ProviderPaymentRow>('/provider-finance/admin/payments', payload);
    return data;
  },

  async getPaymentTotals(by: 'provider' | 'month' | 'year'): Promise<{ key: string; total: number; count: number }[]> {
    const { data } = await adminAxiosClient.get('/provider-finance/admin/payments/totals', { params: { by } });
    return data;
  },

  async uploadReceipt(paymentId: string, file: File): Promise<ProviderPaymentRow> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await adminAxiosClient.post<ProviderPaymentRow>(`/provider-finance/admin/payments/${paymentId}/receipt`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },

  receiptDownloadUrl(paymentId: string): string {
    return `/provider-finance/admin/payments/${paymentId}/receipt`;
  },
};
