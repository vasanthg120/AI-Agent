import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Invoice, InvoiceDocument } from '../royalty/schemas/invoice.schema';
import { UsersService } from '../users/users.service';

export type GrossMarginGroupBy = 'salesCustomer' | 'salesUser' | 'quotesCustomer' | 'quotesUser';

export interface GrossMarginReportGroupRow {
  groupKey: string;
  groupLabel: string;
  totalCost: number;
  totalIncome: number;
  marginAmount: number;
  marginPct: number;
}

export interface GrossMarginReportSummary {
  dateFrom: string;
  dateTo: string;
  groupBy: GrossMarginGroupBy;
  hasCostData: boolean;
  totalInvoicesInRange: number;
  invoicesWithCost: number;
  coveragePct: number;
  totalCost: number;
  totalIncome: number;
  marginAmount: number;
  marginPct: number;
  groups: GrossMarginReportGroupRow[];
  note: string;
}

// Real Gross Margin, computed from Invoice.costAmount — a manually-entered
// field (see invoice.schema.ts's own comment), never fabricated. An invoice
// with no cost entered is excluded from every total, not treated as
// zero-cost (a "$0 cost" row would silently overstate margin) — coveragePct
// always says how much of the range is actually backed by real data,
// matching this app's established "N of M tagged" honesty convention (Deal
// Performance's leadSource/product tagging, Finance's vendor breakdowns).
//
// "Quotes" grouping has no real answer here — Quote has no cost concept
// anywhere in this codebase (no line items, no per-item price/cost split) —
// so those two groupBy values stay an honest empty state, same as before
// this change, rather than silently reinterpreting them as something else.
@Injectable()
export class GrossMarginReportService {
  constructor(
    @InjectModel(Invoice.name) private invoiceModel: Model<InvoiceDocument>,
    private usersService: UsersService,
  ) {}

  async generate(
    organizationId: string,
    dateFrom: string,
    dateTo: string,
    groupBy: GrossMarginGroupBy,
    storeConstraint?: string,
  ): Promise<GrossMarginReportSummary> {
    // Real counts default to 0 for the quotesCustomer/quotesUser early
    // return below, where no invoice query has run yet — but the "invoices
    // exist, none have cost" case further down MUST pass its actual counts
    // here. Previously these were hardcoded to 0 unconditionally, so the
    // note text would correctly say e.g. "39 invoice(s) fall within this
    // range" while the numeric totalInvoicesInRange field sitting right next
    // to it in the same response said 0 — any UI reading the numeric field
    // instead of parsing the note showed "0 of 0", not the real coverage.
    const empty = (note: string, counts?: { totalInvoicesInRange: number; invoicesWithCost: number; coveragePct: number }): GrossMarginReportSummary => ({
      dateFrom,
      dateTo,
      groupBy,
      hasCostData: false,
      totalInvoicesInRange: counts?.totalInvoicesInRange ?? 0,
      invoicesWithCost: counts?.invoicesWithCost ?? 0,
      coveragePct: counts?.coveragePct ?? 0,
      totalCost: 0,
      totalIncome: 0,
      marginAmount: 0,
      marginPct: 0,
      groups: [],
      note,
    });

    if (groupBy === 'quotesCustomer' || groupBy === 'quotesUser') {
      return empty(
        'Quotes have no cost data in this system — there are no per-item price/cost fields to compute a margin from. Switch to a "Sales" (Per Customer / Per User) grouping, which computes real Gross Margin from Invoices that have a Cost entered.',
      );
    }

    const rangeStart = new Date(dateFrom);
    // Explicit 'Z' (UTC) end-of-day — `.setHours()` mutates in the server
    // process's local timezone, which drifts hours off this boundary on any
    // server not running in UTC.
    const rangeEnd = new Date(`${dateTo}T23:59:59.999Z`);
    const match: Record<string, unknown> = {
      organizationId,
      invoiceDate: { $gte: rangeStart, $lte: rangeEnd },
      voidStatus: { $ne: true },
      ...(storeConstraint ? { storeId: storeConstraint } : {}),
    };
    const invoices = await this.invoiceModel.find(match).exec();
    const totalInvoicesInRange = invoices.length;
    const tagged = invoices.filter((inv) => inv.costAmount !== undefined && inv.costAmount !== null);
    const invoicesWithCost = tagged.length;
    const coveragePct = totalInvoicesInRange > 0 ? Math.round((invoicesWithCost / totalInvoicesInRange) * 1000) / 10 : 0;

    if (invoicesWithCost === 0) {
      return empty(
        totalInvoicesInRange === 0
          ? 'No invoices fall within this date range yet, so there is nothing to compute a Gross Margin from.'
          : `${totalInvoicesInRange} invoice(s) fall within this date range, but none has a Cost entered yet. Add a Cost value on an invoice (Royalty Invoices page) to start seeing real Gross Margin numbers here.`,
        { totalInvoicesInRange, invoicesWithCost, coveragePct },
      );
    }

    const totalCost = round2(tagged.reduce((sum, inv) => sum + (inv.costAmount ?? 0), 0));
    const totalIncome = round2(tagged.reduce((sum, inv) => sum + inv.currentValue, 0));
    const marginAmount = round2(totalIncome - totalCost);
    const marginPct = totalIncome > 0 ? Math.round((marginAmount / totalIncome) * 1000) / 10 : 0;

    let groups: GrossMarginReportGroupRow[];
    if (groupBy === 'salesUser') {
      const users = await this.usersService.findAll(organizationId);
      const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
      groups = this.groupByKey(
        tagged,
        (inv) => inv.salespersonId ?? '__unassigned__',
        (key) => (key === '__unassigned__' ? 'Unassigned' : (nameById.get(key) ?? 'Unknown user')),
      );
    } else {
      groups = this.groupByKey(
        tagged,
        (inv) => inv.clientDetails?.companyName ?? inv.invoiceNumber,
        (key) => key,
      );
    }

    return {
      dateFrom,
      dateTo,
      groupBy,
      hasCostData: true,
      totalInvoicesInRange,
      invoicesWithCost,
      coveragePct,
      totalCost,
      totalIncome,
      marginAmount,
      marginPct,
      groups,
      note: `Computed from ${invoicesWithCost} of ${totalInvoicesInRange} invoice(s) in this date range that have a Cost entered (${coveragePct}% coverage). Invoices without a Cost value are excluded from every total, not treated as zero-cost.`,
    };
  }

  private groupByKey(
    invoices: InvoiceDocument[],
    keyFn: (inv: InvoiceDocument) => string,
    labelFn: (key: string) => string,
  ): GrossMarginReportGroupRow[] {
    const sums = new Map<string, { cost: number; income: number }>();
    for (const inv of invoices) {
      const key = keyFn(inv);
      const entry = sums.get(key) ?? { cost: 0, income: 0 };
      entry.cost += inv.costAmount ?? 0;
      entry.income += inv.currentValue;
      sums.set(key, entry);
    }
    const rows = [...sums.entries()].map(([key, { cost, income }]) => {
      const marginAmount = round2(income - cost);
      return {
        groupKey: key,
        groupLabel: labelFn(key),
        totalCost: round2(cost),
        totalIncome: round2(income),
        marginAmount,
        marginPct: income > 0 ? Math.round((marginAmount / income) * 1000) / 10 : 0,
      };
    });
    rows.sort((a, b) => b.totalIncome - a.totalIncome);
    return rows;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
