import { Injectable } from '@nestjs/common';
import { countedNote, QuotationSalesService, round2, totalsOf } from './quotation-sales.service';
import { ReportingSettingsService } from './reporting-settings.service';
import { groupRows, SalesReportService } from './sales-report.service';

export type GrossMarginGroupBy = 'customer' | 'user';

export interface GrossMarginReportGroupRow {
  groupKey: string;
  groupLabel: string;
  quotations: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  /** The margin percentage applied to this group's sales excluding tax. Null until a percentage is set. */
  grossMargin: number | null;
}

export interface GrossMarginReportSummary {
  dateFrom: string;
  dateTo: string;
  groupBy: GrossMarginGroupBy;
  /** The percentage the organization set (Settings → Royalty Rules). Null = none set yet. */
  marginPct: number | null;
  quotations: number;
  accepted: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  /** marginPct of totalSalesExTax — an estimate, never a measured figure. */
  grossMargin: number | null;
  groups: GrossMarginReportGroupRow[];
  note: string;
}

/** A percentage of an amount, to the paisa. */
export const marginOn = (salesExTax: number, marginPct: number | null): number | null => (marginPct === null ? null : round2((salesExTax * marginPct) / 100));

// The Gross Margin report. Neither the CRM nor HaiVE holds what a job cost
// (the CRM's own "margin" field on a product is its catalogue price), and
// costs are not entered by hand — so the margin shown is the organization's
// own percentage, set once, applied to sales excluding tax. It is always
// labelled an estimate. Sales are the same quotations the Sales and Royalty
// reports count; until a percentage is set the sales are shown and the
// margin is left blank rather than guessed.
@Injectable()
export class GrossMarginReportService {
  constructor(
    private quotationSales: QuotationSalesService,
    private salesReport: SalesReportService,
    private settings: ReportingSettingsService,
  ) {}

  async generate(
    organizationId: string,
    dateFrom: string,
    dateTo: string,
    groupingBy: GrossMarginGroupBy,
    storeConstraint?: string,
  ): Promise<GrossMarginReportSummary> {
    const [sales, { grossMarginPct: marginPct }] = await Promise.all([
      this.quotationSales.sent(organizationId, dateFrom, dateTo, storeConstraint),
      this.settings.get(organizationId),
    ]);
    const totals = totalsOf(sales);
    const rows = groupRows(await this.salesReport.groups(organizationId, sales, groupingBy), totals.salesExTax);
    return {
      dateFrom,
      dateTo,
      groupBy: groupingBy,
      marginPct,
      quotations: totals.quotations,
      accepted: totals.accepted,
      totalSalesExTax: totals.salesExTax,
      totalTax: totals.tax,
      totalSalesIncTax: totals.salesIncTax,
      grossMargin: marginOn(totals.salesExTax, marginPct),
      groups: rows.map(({ percentOfSales: _share, ...row }) => ({ ...row, grossMargin: marginOn(row.salesExTax, marginPct) })),
      note:
        (marginPct === null
          ? 'No gross margin percentage is set yet, so sales are shown without a margin. Set it once in Settings → Royalty Rules.'
          : `Gross margin is an estimate: ${marginPct}% of sales excluding tax — the percentage set in Settings → Royalty Rules. No cost is recorded for what was sold, so it is not a measured margin.`) +
        ' ' +
        countedNote(totals),
    };
  }
}
