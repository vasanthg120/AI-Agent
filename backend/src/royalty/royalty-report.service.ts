import { Injectable } from '@nestjs/common';
import { countedNote, round2, totalsOf, WonSale, WonSalesService } from '../reporting/won-sales.service';
import { SalesReportService } from '../reporting/sales-report.service';
import { RoyaltyRule } from './schemas/royalty-rule.schema';
import { RoyaltyRulesService } from './royalty-rules.service';

/** One deal won in the period, with what royalty falls on it. */
export interface RoyaltyReportSaleLine {
  dealId: string;
  dealName: string;
  /** The quotations behind it, e.g. "113, 108". */
  quoteNumbers?: string;
  customerName: string;
  /** The day the deal closed, YYYY-MM-DD. */
  date: string;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  /** What the royalty is charged on for this deal. */
  eligibleValue: number;
  /** At the period's rate, before any cap. */
  royalty: number;
}

export interface RoyaltyReportSalesSummary {
  totalRecords: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  totalRoyalty: number;
}

// "Group By" breakdown — the same won deals, by salesperson or customer,
// with the royalty each group carries at the period's rate (before any cap).
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
  // What the amounts are in: the shown CRM's currency (Pantheras INR, Hoops AUD).
  currency: string;
  scope: { level: 'org' | 'store'; storeId?: string };
  royaltyRule: {
    royaltyPercentage: number;
    capType: string;
    capValue?: number;
    effectiveDate: Date;
    excludeTax: boolean;
  } | null;
  /** Deals won in the period. */
  wonDeals: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  /** Which of the two the royalty is charged on: excluding tax, unless the rule says tax is not excluded. */
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
  // Present only when a groupBy was requested.
  groupBy: 'salesperson' | 'customer' | null;
  groupedBreakdown: RoyaltyReportGroupRow[];
}

type RuleTerms = Pick<RoyaltyRule, 'royaltyPercentage' | 'capType' | 'capValue' | 'slidingTiers'>;

/**
 * The royalty a rule puts on an amount of sales: the rate in force (a sliding scale picks the one bracket
 * the amount falls in, and that rate applies to the whole amount), the fee at that rate, and what is due
 * once a minimum (a floor) or a maximum (a ceiling) is applied.
 */
export function royaltyOn(eligibleRevenue: number, rule: RuleTerms | null): { ratePct: number; feeBeforeCap: number; totalDue: number } {
  if (!rule) return { ratePct: 0, feeBeforeCap: 0, totalDue: 0 };
  let ratePct = rule.royaltyPercentage;
  if (rule.capType === 'sliding' && rule.slidingTiers.length > 0) {
    const tier = rule.slidingTiers.find(
      (t) => eligibleRevenue >= t.fromValue && (t.toValue === undefined || t.toValue === null || eligibleRevenue < t.toValue),
    );
    if (tier) ratePct = tier.percentage;
  }
  const feeBeforeCap = round2(eligibleRevenue * (ratePct / 100));
  let totalDue = feeBeforeCap;
  if (rule.capType === 'min' && typeof rule.capValue === 'number') totalDue = Math.max(feeBeforeCap, rule.capValue);
  if (rule.capType === 'max' && typeof rule.capValue === 'number') totalDue = Math.min(feeBeforeCap, rule.capValue);
  return { ratePct, feeBeforeCap, totalDue: round2(totalDue) };
}

// The Royalty report: what is owed to the franchisor on a period's sales.
// Sales are the deals won in the period — the same ones the Sales and Gross
// Margin reports count (reporting/won-sales.service.ts) — each at the deal's
// value, its tax split as on its quotations. Nothing is read from invoices.
//
// The royalty is charged on sales excluding tax (the rule's "Exclude tax"
// switch, on unless somebody turns it off), at the rule in force at the end
// of the period — never the merely-latest rule, so a past period keeps the
// rate it had. A deal's fees (setup, delivery) are part of its value:
// the CRM does not say which part of a fee is delivery, so none is taken off.
@Injectable()
export class RoyaltyReportService {
  constructor(
    private wonSales: WonSalesService,
    private salesReport: SalesReportService,
    private royaltyRulesService: RoyaltyRulesService,
  ) {}

  async generateReport(
    organizationId: string,
    dateFrom: string,
    dateTo: string,
    storeConstraint?: string,
    groupBy?: 'salesperson' | 'customer',
  ): Promise<RoyaltyReportSummary> {
    const [rule, sales, currency] = await Promise.all([
      this.royaltyRulesService.getEffectiveRule(organizationId, new Date(`${dateTo}T23:59:59.999Z`)),
      this.wonSales.won(organizationId, dateFrom, dateTo, storeConstraint),
      this.wonSales.currency(organizationId),
    ]);
    const totals = totalsOf(sales);
    const royaltyBase: 'exTax' | 'incTax' = rule && rule.excludeTax === false ? 'incTax' : 'exTax';
    const eligibleOf = (sale: WonSale) => (royaltyBase === 'exTax' ? sale.salesExTax : sale.salesIncTax);
    const eligibleRevenue = royaltyBase === 'exTax' ? totals.salesExTax : totals.salesIncTax;
    const { ratePct, feeBeforeCap, totalDue } = royaltyOn(eligibleRevenue, rule);

    const lines: RoyaltyReportSaleLine[] = sales.map((sale) => ({
      dealId: sale.id,
      dealName: sale.dealName,
      quoteNumbers: sale.quoteNumbers,
      customerName: sale.customer,
      date: sale.date,
      salesExTax: sale.salesExTax,
      tax: sale.tax,
      salesIncTax: sale.salesIncTax,
      eligibleValue: eligibleOf(sale),
      royalty: round2(eligibleOf(sale) * (ratePct / 100)),
    }));

    let groupedBreakdown: RoyaltyReportGroupRow[] = [];
    if (groupBy) {
      const groups = await this.salesReport.groups(organizationId, sales, groupBy === 'salesperson' ? 'user' : 'customer');
      groupedBreakdown = groups
        .map((group) => {
          const eligible = group.sales.reduce((sum, sale) => sum + eligibleOf(sale), 0);
          const exTax = round2(group.sales.reduce((sum, sale) => sum + sale.salesExTax, 0));
          return {
            groupKey: group.key,
            groupLabel: group.label,
            totalSalesExTax: exTax,
            percentOfSales: totals.salesExTax > 0 ? Math.round((exTax / totals.salesExTax) * 1000) / 10 : 0,
            royaltyDue: round2(eligible * (ratePct / 100)),
          };
        })
        .sort((a, b) => b.totalSalesExTax - a.totalSalesExTax);
    }

    return {
      dateFrom,
      dateTo,
      currency,
      scope: storeConstraint ? { level: 'store', storeId: storeConstraint } : { level: 'org' },
      royaltyRule: rule
        ? {
            royaltyPercentage: rule.royaltyPercentage,
            capType: rule.capType,
            capValue: rule.capValue,
            effectiveDate: rule.effectiveDate,
            excludeTax: rule.excludeTax !== false,
          }
        : null,
      wonDeals: totals.deals,
      salesExTax: totals.salesExTax,
      tax: totals.tax,
      salesIncTax: totals.salesIncTax,
      royaltyBase,
      eligibleRevenue,
      royaltyFeeBeforeCap: feeBeforeCap,
      totalDue,
      effectiveRoyaltyPct: rule && eligibleRevenue > 0 ? Math.round((totalDue / eligibleRevenue) * 1000) / 10 : null,
      // Flat amounts configured on the rule — not worked out from sales.
      marketingFeeAmount: rule?.marketingFeeAmount ?? null,
      otherFeeAmount: rule?.otherFeeAmount ?? null,
      dataSourceNote: `${countedNote(totals)} Royalty is charged on sales ${royaltyBase === 'exTax' ? 'excluding' : 'including'} tax.`,
      sales: lines,
      salesSummary: {
        totalRecords: lines.length,
        totalSalesExTax: totals.salesExTax,
        totalTax: totals.tax,
        totalSalesIncTax: totals.salesIncTax,
        totalRoyalty: round2(lines.reduce((sum, l) => sum + l.royalty, 0)),
      },
      groupBy: groupBy ?? null,
      groupedBreakdown,
    };
  }
}
