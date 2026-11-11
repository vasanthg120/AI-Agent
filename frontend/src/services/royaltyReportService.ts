import { axiosClient } from '@/api/axiosClient';

// One deal won in the period, with what royalty falls on it.
export interface RoyaltyReportSaleLine {
  dealId: string;
  dealName: string;
  // The quotations behind it, e.g. "113, 108".
  quoteNumbers?: string;
  customerName: string;
  // The day the deal closed, YYYY-MM-DD.
  date: string;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  // What the royalty is charged on for this deal.
  eligibleValue: number;
  // At the period's rate, before any cap.
  royalty: number;
}

export interface RoyaltyReportSalesSummary {
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
  // Deals won in the period.
  wonDeals: number;
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
  sales: RoyaltyReportSaleLine[];
  salesSummary: RoyaltyReportSalesSummary;
  groupBy: 'salesperson' | 'customer' | null;
  groupedBreakdown: RoyaltyReportGroupRow[];
}

// Worked out on the backend from the deals won in the period — the same ones
// the Sales and Gross Margin reports count — each at the deal's value, its tax
// split as on its quotations. Nothing is read from invoices. Takes an
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
