import { adminAxiosClient } from '@/api/adminAxiosClient';

// Platform expenditure/balance/payment tracking for LLM providers — see
// backend/src/provider-finance/provider-finance.service.ts's own class
// comment. Balance is never a typed-in number here: neither Anthropic nor
// Groq expose a real balance-check API, so it's an honest capability status
// ("UNSUPPORTED" for both today), never a manual entry or a guess.

export type FinanceProvider = 'anthropic' | 'groq';

export type CapabilityStatus = 'SUPPORTED' | 'UNSUPPORTED' | 'PERMISSION_REQUIRED' | 'CONFIGURATION_REQUIRED' | 'ERROR';

export interface CapabilityEntry {
  status: CapabilityStatus;
  detail: string;
}

export const PROVIDER_CAPABILITIES = [
  'BALANCE_READ',
  'USAGE_COST_READ',
  'INVOICE_HISTORY_READ',
  'PAYMENT_HISTORY_READ',
  'AUTO_RECHARGE_READ',
  'AUTO_RECHARGE_CONFIGURE',
  'SPEND_LIMIT_READ',
  'SPEND_LIMIT_CONFIGURE',
  'RATE_LIMIT_READ',
  'EXHAUSTION_DETECTION',
] as const;
export type ProviderCapabilityKey = (typeof PROVIDER_CAPABILITIES)[number];
export type CapabilityMatrix = Record<ProviderCapabilityKey, CapabilityEntry>;

export interface ProviderAccountView {
  provider: string;
  accountIdentifier: string | null;
  // Operational health for AI *requests* — unrelated to finance capability.
  status: 'active' | 'degraded' | 'exhausted' | 'unknown';
  // status !== 'exhausted' — exposed directly so the UI never has to
  // re-derive it (or accidentally compare against the literal 'active',
  // which nothing in this app ever actually writes).
  operational: boolean;
  // A real chat-completion credential is on file for this provider — fully
  // independent of finance/capability/sync state.
  connected: boolean;
  accountType: 'prepaid' | 'postpaid' | 'usage-limited' | 'balance-unavailable';
  currency: string;
  balance: { status: CapabilityStatus; note: string };
  monthlyBudget: number | null;
  consumptionThisMonth: number;
  consumptionPeriod: { start: string; end: string; timezone: string };
  budgetPacePct: number | null;
  hasAdminApiKey: boolean;
  capabilities: CapabilityMatrix | null;
  usageCostSync: {
    lastSuccessAt: string | null;
    lastAttemptedAt: string | null;
    lastError: string | null;
    // null = never attempted; true/false = the most recent attempt's real
    // outcome — this doubles as "is the Admin API key actually valid".
    lastAttemptSuccessful: boolean | null;
    providerReportedCostThisMonth: number | null;
    costVariancePct: number | null;
    nextScheduledSyncAt: string | null;
  };
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

export interface AlertLogRow {
  _id: string;
  provider: string;
  alertType: string;
  title: string;
  message: string;
  createdAt: string;
}

export interface FinanceDashboard {
  days: number;
  periodStart: string;
  periodEnd: string;
  totalPaymentsInRange: number;
  totalConsumptionThisMonth: number;
  activeProviderCount: number;
  nearOrOverBudgetProviderCount: number;
  exhaustedProviderCount: number;
  needsConfigurationProviderCount: number;
  lastPaymentDate: string | null;
  nextExpectedRechargeDateEstimate: string | null;
  accounts: ProviderAccountView[];
}

export interface Profitability {
  days: number;
  periodStart: string;
  periodEnd: string;
  totalRevenueCredits: number;
  totalRevenueUsd: number;
  totalProviderCostUsd: number;
  grossProfitUsd: number;
  grossMarginPct: number | null;
  reportingCurrency: string;
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

  async getRecentAlerts(limit = 20): Promise<AlertLogRow[]> {
    const { data } = await adminAxiosClient.get<AlertLogRow[]>('/provider-finance/admin/alerts', { params: { limit } });
    return data;
  },

  async getAccounts(): Promise<ProviderAccountView[]> {
    const { data } = await adminAxiosClient.get<ProviderAccountView[]>('/provider-finance/admin/accounts');
    return data;
  },

  async upsertAccount(provider: string, patch: { accountIdentifier?: string; accountType?: string; currency?: string; monthlyBudget?: number; alertRecipients?: string[] }): Promise<ProviderAccountView> {
    const { data } = await adminAxiosClient.patch<ProviderAccountView>(`/provider-finance/admin/accounts/${provider}`, patch);
    return data;
  },

  async setAdminApiKey(provider: string, adminApiKey: string): Promise<ProviderAccountView> {
    const { data } = await adminAxiosClient.post<ProviderAccountView>(`/provider-finance/admin/accounts/${provider}/admin-api-key`, { adminApiKey });
    return data;
  },

  async clearAdminApiKey(provider: string): Promise<ProviderAccountView> {
    const { data } = await adminAxiosClient.delete<ProviderAccountView>(`/provider-finance/admin/accounts/${provider}/admin-api-key`);
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
