import { axiosClient } from '@/api/axiosClient';

export type GrossMarginGroupBy = 'customer' | 'user';

export interface GrossMarginReportGroupRow {
  groupKey: string;
  groupLabel: string;
  quotations: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  // The margin percentage applied to this group's sales excluding tax. Null until a percentage is set.
  grossMargin: number | null;
}

export interface GrossMarginReportSummary {
  dateFrom: string;
  dateTo: string;
  groupBy: GrossMarginGroupBy;
  // The percentage the organization set (Settings → Royalty Rules). Null = none set yet.
  marginPct: number | null;
  quotations: number;
  accepted: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  // marginPct of totalSalesExTax — an estimate, never a measured figure.
  grossMargin: number | null;
  groups: GrossMarginReportGroupRow[];
  note: string;
}

// What the organization tells the reports once.
export interface ReportingSettings {
  grossMarginPct: number | null;
  updatedAt?: string;
  updatedByName?: string;
}

// No cost is recorded for what is sold (not in the CRM, not in HaiVE), so the
// margin is the organization's own percentage applied to sales excluding tax —
// always shown as an estimate, and left blank until the percentage is set.
export const grossMarginReportService = {
  async generate(dateFrom: string, dateTo: string, groupBy: GrossMarginGroupBy): Promise<GrossMarginReportSummary> {
    const { data } = await axiosClient.get<GrossMarginReportSummary>('/reporting/gross-margin', {
      params: { dateFrom, dateTo, groupBy },
    });
    return data;
  },

  async getSettings(): Promise<ReportingSettings> {
    const { data } = await axiosClient.get<ReportingSettings>('/reporting/settings');
    return data;
  },

  // null clears the percentage. Owners and administrators only.
  async setGrossMarginPct(grossMarginPct: number | null): Promise<ReportingSettings> {
    const { data } = await axiosClient.put<ReportingSettings>('/reporting/settings', { grossMarginPct });
    return data;
  },
};
