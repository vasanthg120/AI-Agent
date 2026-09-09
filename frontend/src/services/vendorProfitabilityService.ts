import { axiosClient } from '@/api/axiosClient';
import type { BiFilters } from './emailAnalyticsService';

export type VendorProfitabilityPaymentStatus = 'paid' | 'partially_paid' | 'pending';

export interface VendorProfitabilityRow {
  dealId: string;
  dealName?: string;
  vendorNames: string[];
  // Expected/agreed vendor cost (all non-cancelled linked documents,
  // regardless of payment status) — the basis Gross Profit/Margin/Markup are
  // computed from. Never gated on whether the vendor has actually been paid.
  vendorCost: number;
  // Actual cash paid so far (paid/partially_paid documents only) — a
  // separate, payment-status-aware figure, never used for profitability.
  actualVendorCostPaid: number;
  vendorCostCurrency: string;
  customerRevenue: number;
  customerRevenueCurrency: string;
  customerPaid: number;
  grossProfit: number | null;
  grossMarginPct: number | null;
  markupPct: number | null;
  currencyMismatch: boolean;
  vendorQuoteCount: number;
  quoteCount: number;
  vendorPaymentStatus: VendorProfitabilityPaymentStatus;
  customerPaymentStatus: VendorProfitabilityPaymentStatus;
  vendorQuoteNumbers: string[];
  customerQuoteNo?: string;
}

export interface VendorProfitabilityOverview {
  rows: VendorProfitabilityRow[];
  totals: {
    customerRevenue: number;
    vendorCost: number;
    actualVendorCostPaid: number;
    grossProfit: number;
    grossMarginPct: number | null;
    markupPct: number | null;
  };
  coveragePct: number | null;
  currencyMismatchCount: number;
}

export interface VendorProfitabilityFinanceDocument {
  id: string;
  originalFilename: string;
  invoiceNumber?: string;
  vendorName?: string;
  paymentAmount: number;
  currency: string;
  paymentStatus: string;
  dueDate?: string;
  paymentDate?: string;
  aiSummary?: string;
  gridFsFileId: string;
}

export interface VendorProfitabilityQuoteLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface VendorProfitabilityQuote {
  id: string;
  quoteNumber?: string;
  customerName?: string;
  quoteAmount: number;
  currency: string;
  clientApprovalStatus: string;
  paidAmount: number;
  items: VendorProfitabilityQuoteLineItem[];
}

export interface VendorProfitabilityDealDetail extends VendorProfitabilityRow {
  financeDocuments: VendorProfitabilityFinanceDocument[];
  quotes: VendorProfitabilityQuote[];
}

export interface VendorCustomerCompareResult {
  transactionNotes: { dealId: string; commentary: string }[];
  aggregateNarrative: string;
  flaggedTransactions: { dealId: string; reason: string }[];
}

function toParams(filters: BiFilters & { vendorId?: string[] }): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (filters.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters.dateTo) params.dateTo = filters.dateTo;
  if (filters.vendorId?.length) params.vendorId = filters.vendorId.join(',');
  return params;
}

export const vendorProfitabilityService = {
  async getOverview(filters: BiFilters & { vendorId?: string[] }): Promise<VendorProfitabilityOverview> {
    const { data } = await axiosClient.get<VendorProfitabilityOverview>('/business-intelligence/vendor-profitability', {
      params: toParams(filters),
    });
    return data;
  },

  async requestAiComparison(filters: BiFilters & { vendorId?: string[] }): Promise<VendorCustomerCompareResult> {
    const { data } = await axiosClient.post<VendorCustomerCompareResult>(
      '/business-intelligence/vendor-profitability/ai-compare',
      {},
      { params: toParams(filters) },
    );
    return data;
  },

  async getDealDetail(dealId: string): Promise<VendorProfitabilityDealDetail> {
    const { data } = await axiosClient.get<VendorProfitabilityDealDetail>(`/business-intelligence/vendor-profitability/deals/${dealId}`);
    return data;
  },
};
