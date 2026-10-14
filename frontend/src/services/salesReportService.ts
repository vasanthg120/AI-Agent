import { axiosClient } from '@/api/axiosClient';

export type SalesGroupBy = 'customer' | 'user' | 'quoteOwner';

export interface SalesReportGroupRow {
  groupKey: string;
  groupLabel: string;
  quotations: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  // This group's share of the period's sales (excluding tax).
  percentOfSales: number;
}

export interface SalesReportSummary {
  dateFrom: string;
  dateTo: string;
  groupBy: SalesGroupBy;
  // Quotations sent in the period, and how many of them the customer has accepted.
  quotations: number;
  accepted: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  groups: SalesReportGroupRow[];
  dataSourceNote: string;
}

// Sales = every quotation sent in the period, with the value and the tax the
// quotation itself carries (backend/src/reporting/quotation-sales.service.ts).
// The Gross Margin and Royalty reports count the same quotations.
export const salesReportService = {
  async generate(dateFrom: string, dateTo: string, groupBy: SalesGroupBy): Promise<SalesReportSummary> {
    const { data } = await axiosClient.get<SalesReportSummary>('/reporting/sales', {
      params: { dateFrom, dateTo, groupBy },
    });
    return data;
  },
};
