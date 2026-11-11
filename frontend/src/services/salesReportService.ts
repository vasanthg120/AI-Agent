import { axiosClient } from '@/api/axiosClient';

export type SalesGroupBy = 'customer' | 'user' | 'quoteOwner';

export interface SalesReportGroupRow {
  groupKey: string;
  groupLabel: string;
  // Won deals in this group.
  deals: number;
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
  // Deals won in the period.
  deals: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  groups: SalesReportGroupRow[];
  dataSourceNote: string;
}

// Sales = the deals won in the period, by the day each closed, at the deal's
// value — the Dashboard's revenue — with the tax split as on their quotations
// (backend/src/reporting/won-sales.service.ts). Gross Margin and Royalty count
// the same deals.
export const salesReportService = {
  async generate(dateFrom: string, dateTo: string, groupBy: SalesGroupBy): Promise<SalesReportSummary> {
    const { data } = await axiosClient.get<SalesReportSummary>('/reporting/sales', {
      params: { dateFrom, dateTo, groupBy },
    });
    return data;
  },
};
