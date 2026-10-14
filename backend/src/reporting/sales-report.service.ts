import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { countedNote, QuotationSale, QuotationSalesService, totalsOf } from './quotation-sales.service';

export type SalesGroupBy = 'customer' | 'user' | 'quoteOwner';

export interface SalesReportGroupRow {
  groupKey: string;
  groupLabel: string;
  quotations: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
  /** This group's share of the period's sales (excluding tax). */
  percentOfSales: number;
}

export interface SalesReportSummary {
  dateFrom: string;
  dateTo: string;
  groupBy: SalesGroupBy;
  /** Quotations sent in the period, and how many of them the customer has accepted. */
  quotations: number;
  accepted: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  groups: SalesReportGroupRow[];
  dataSourceNote: string;
}

export interface SalesGroup {
  key: string;
  label: string;
  sales: QuotationSale[];
}

export const UNLINKED_OWNER = 'Owner not linked to a user';

/** Quotations put into groups, each group with its three totals and its share; the biggest first. */
export function groupRows(groups: SalesGroup[], totalSalesExTax: number): SalesReportGroupRow[] {
  return groups
    .map(({ key, label, sales }) => {
      const totals = totalsOf(sales);
      return {
        groupKey: key,
        groupLabel: label,
        quotations: totals.quotations,
        salesExTax: totals.salesExTax,
        tax: totals.tax,
        salesIncTax: totals.salesIncTax,
        percentOfSales: totalSalesExTax > 0 ? Math.round((totals.salesExTax / totalSalesExTax) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.salesExTax - a.salesExTax || a.groupLabel.localeCompare(b.groupLabel));
}

export function groupBy(sales: QuotationSale[], keyOf: (sale: QuotationSale) => { key: string; label: string }): SalesGroup[] {
  const groups = new Map<string, SalesGroup>();
  for (const sale of sales) {
    const { key, label } = keyOf(sale);
    if (!groups.has(key)) groups.set(key, { key, label, sales: [] });
    groups.get(key)!.sales.push(sale);
  }
  return [...groups.values()];
}

// The Sales report: what was quoted in a period, grouped by customer, by the
// user who owns the deal, or by the quotation's owner — each shown excluding
// tax, its tax, and including tax. Built on the one definition of sales the
// three reports share (quotation-sales.service.ts): every quotation sent in
// the period, with the value and tax the quotation itself carries. No
// invoice and no cost is involved.
@Injectable()
export class SalesReportService {
  constructor(
    private quotationSales: QuotationSalesService,
    private usersService: UsersService,
  ) {}

  async generate(organizationId: string, dateFrom: string, dateTo: string, groupingBy: SalesGroupBy, storeConstraint?: string): Promise<SalesReportSummary> {
    const sales = await this.quotationSales.sent(organizationId, dateFrom, dateTo, storeConstraint);
    const totals = totalsOf(sales);
    const groups = await this.groups(organizationId, sales, groupingBy);
    const rows = groupRows(groups, totals.salesExTax);
    const unlinked = groupingBy === 'quoteOwner' && rows.some((g) => g.groupLabel === UNLINKED_OWNER);
    return {
      dateFrom,
      dateTo,
      groupBy: groupingBy,
      quotations: totals.quotations,
      accepted: totals.accepted,
      totalSalesExTax: totals.salesExTax,
      totalTax: totals.tax,
      totalSalesIncTax: totals.salesIncTax,
      groups: rows,
      dataSourceNote:
        countedNote(totals) +
        (unlinked
          ? ' Some quotations belong to a CRM owner that is not linked to a HaiVE user yet — link them in Settings → Deal Assignment to see a name.'
          : ''),
    };
  }

  /** The same quotations, grouped the way the other reports group them too. */
  async groups(organizationId: string, sales: QuotationSale[], groupingBy: SalesGroupBy): Promise<SalesGroup[]> {
    if (groupingBy === 'customer') {
      // One customer however their name is typed: same letters, any case — named as on their latest quotation.
      return groupBy(sales, (sale) => ({ key: sale.customer.toLowerCase(), label: sale.customer }));
    }
    const users = await this.usersService.findAll(organizationId);
    const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    if (groupingBy === 'user') {
      // The user who owns the deal the quotation was raised from; failing that, whoever the quotation is assigned to.
      const dealOwner = await this.quotationSales.dealOwners(organizationId, sales);
      return groupBy(sales, (sale) => {
        const owner = (sale.dealId ? dealOwner.get(sale.dealId) : undefined) ?? sale.ownerUserId;
        if (!owner) return { key: '__unassigned__', label: 'Unassigned' };
        return { key: owner, label: nameById.get(owner) ?? 'Unknown user' };
      });
    }
    // The quotation's owner, as a person: the HaiVE user the CRM's owner is
    // linked to (Settings → Deal Assignment) when there is one, otherwise the
    // owner's name as the CRM gives it. The CRM's raw owner id is an internal
    // reference and is never shown. Two CRM owners linked to the same person
    // are one row.
    return groupBy(sales, (sale) => {
      const userId =
        sale.ownerUserId && nameById.has(sale.ownerUserId) ? sale.ownerUserId : sale.quoteOwner && nameById.has(sale.quoteOwner) ? sale.quoteOwner : undefined;
      if (userId) return { key: `user:${userId}`, label: nameById.get(userId)! };
      if (sale.quoteOwnerLabel) return { key: `crm:${sale.quoteOwnerLabel.toLowerCase()}`, label: sale.quoteOwnerLabel };
      return sale.quoteOwner ? { key: '__unlinked__', label: UNLINKED_OWNER } : { key: '__none__', label: 'No owner on the quotation' };
    });
  }
}
