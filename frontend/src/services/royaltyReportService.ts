import { axiosClient } from '@/api/axiosClient';

// One quotation of the period, with what royalty falls on it.
export interface RoyaltyReportQuotationLine {
  quoteId: string;
  quoteNumber?: string;
  customerName: string;
  // The quotation's own date, YYYY-MM-DD.
  date: string;
  accepted: boolean;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  // What the royalty is charged on for this quotation.
  eligibleValue: number;
  // At the period's rate, before any cap.
  royalty: number;
}

export interface RoyaltyReportQuotationsSummary {
  totalRecords: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  totalRoyalty: number;
}

export interface RoyaltyReportGroupRow {
  groupKey: string;
  groupLabel: string;
  totalSalesExTax: number;
  percentOfSales: number;
  royaltyDue: number;
}

export interface RoyaltyReportSummary {
  dateFrom: string;
  dateTo: string;
  scope: { level: 'org' | 'store'; storeId?: string };
  royaltyRule: {
    royaltyPercentage: number;
    capType: 'none' | 'min' | 'max' | 'sliding';
    capValue?: number;
    effectiveDate: string;
    excludeTax: boolean;
  } | null;
  // Quotations sent in the period; of them, accepted by the customer and not accepted yet.
  totalQuotes: number;
  totalAcceptedQuotes: number;
  totalNotAcceptedQuotes: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  // Which of the two the royalty is charged on: excluding tax, unless the rule says tax is not excluded.
  royaltyBase: 'exTax' | 'incTax';
  eligibleRevenue: number;
  royaltyFeeBeforeCap: number;
  totalDue: number;
  effectiveRoyaltyPct: number | null;
  marketingFeeAmount: number | null;
  otherFeeAmount: number | null;
  dataSourceNote: string;
  quotations: RoyaltyReportQuotationLine[];
  quotationsSummary: RoyaltyReportQuotationsSummary;
  groupBy: 'salesperson' | 'customer' | null;
  groupedBreakdown: RoyaltyReportGroupRow[];
}

// Worked out on the backend from the quotations sent in the period — the same
// ones the Sales and Gross Margin reports count — each with the value and the
// tax the quotation itself carries. Nothing is read from invoices. Takes an
// arbitrary [dateFrom, dateTo] range, not just a calendar month.
export const royaltyReportService = {
  async generate(
    dateFrom: string,
    dateTo: string,
    groupBy?: 'salesperson' | 'customer',
  ): Promise<RoyaltyReportSummary> {
    const { data } = await axiosClient.get<RoyaltyReportSummary>('/royalty/report', {
      params: { dateFrom, dateTo, ...(groupBy ? { groupBy } : {}) },
    });
    return data;
  },

  // Same blob-download pattern as financeDocumentsService.downloadExport —
  // requires the same bearer auth as every other endpoint, so a plain
  // <a href> can't be used directly.
  async downloadExport(format: 'csv' | 'xlsx' | 'pdf', dateFrom: string, dateTo: string): Promise<void> {
    const response = await axiosClient.get('/royalty/report/export', {
      params: { dateFrom, dateTo, format },
      responseType: 'blob',
    });
    const disposition = response.headers['content-disposition'] as string | undefined;
    const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `royalty-report-${dateFrom}_to_${dateTo}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
