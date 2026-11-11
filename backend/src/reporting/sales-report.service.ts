import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { countedNote, totalsOf, WonSale, WonSalesService } from './won-sales.service';

export type SalesGroupBy = 'customer' | 'user' | 'quoteOwner';

export interface SalesReportGroupRow {
  groupKey: string;
  groupLabel: string;
  /** Won deals in this group. */
  deals: number;
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
  /** Deals won in the period. */
  deals: number;
  totalSalesExTax: number;
  totalTax: number;
  totalSalesIncTax: number;
  groups: SalesReportGroupRow[];
  dataSourceNote: string;
}

export interface SalesGroup {
  key: string;
  label: string;
  sales: WonSale[];
}

export const UNLINKED_OWNER = 'Owner not linked to a user';

/** Sales put into groups, each group with its three totals and its share; the biggest first. */
export function groupRows(groups: SalesGroup[], totalSalesExTax: number): SalesReportGroupRow[] {
  return groups
    .map(({ key, label, sales }) => {
      const totals = totalsOf(sales);
      return {
        groupKey: key,
        groupLabel: label,
        deals: totals.deals,
        salesExTax: totals.salesExTax,
        tax: totals.tax,
        salesIncTax: totals.salesIncTax,
        percentOfSales: totalSalesExTax > 0 ? Math.round((totals.salesExTax / totalSalesExTax) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.salesExTax - a.salesExTax || a.groupLabel.localeCompare(b.groupLabel));
}

export function groupBy(sales: WonSale[], keyOf: (sale: WonSale) => { key: string; label: string }): SalesGroup[] {
  const groups = new Map<string, SalesGroup>();
  for (const sale of sales) {
    const { key, label } = keyOf(sale);
    if (!groups.has(key)) groups.set(key, { key, label, sales: [] });
    groups.get(key)!.sales.push(sale);
  }
  return [...groups.values()];
}

// The Sales report: what was won in a period, grouped by customer, by the
// user who owns the deal, or by the quotation's owner — each shown excluding
// tax, its tax, and including tax. Built on the one definition of sales the
// three reports share (won-sales.service.ts): the deals won in the period, at
// their value, by the day they closed.
@Injectable()
export class SalesReportService {
  constructor(
    private wonSales: WonSalesService,
    private usersService: UsersService,
  ) {}

  async generate(organizationId: string, dateFrom: string, dateTo: string, groupingBy: SalesGroupBy, storeConstraint?: string): Promise<SalesReportSummary> {
    const sales = await this.wonSales.won(organizationId, dateFrom, dateTo, storeConstraint);
    const totals = totalsOf(sales);
    const rows = groupRows(await this.groups(organizationId, sales, groupingBy), totals.salesExTax);
    const unlinked = groupingBy === 'quoteOwner' && rows.some((g) => g.groupLabel === UNLINKED_OWNER);
    return {
      dateFrom,
      dateTo,
      groupBy: groupingBy,
      deals: totals.deals,
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

  /** The same sales, grouped the way the other reports group them too. */
  async groups(organizationId: string, sales: WonSale[], groupingBy: SalesGroupBy): Promise<SalesGroup[]> {
    if (groupingBy === 'customer') {
      // One customer however their name is typed: same letters, any case — named as on their latest deal.
      return groupBy(sales, (sale) => ({ key: sale.customer.toLowerCase(), label: sale.customer }));
    }
    const users = await this.usersService.findAll(organizationId);
    const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    if (groupingBy === 'user') {
      // The user who owns the deal; failing that, whoever its latest quotation is assigned to.
      return groupBy(sales, (sale) => {
        const owner = sale.dealOwnerId ?? sale.quoteOwnerUserId;
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
        sale.quoteOwnerUserId && nameById.has(sale.quoteOwnerUserId)
          ? sale.quoteOwnerUserId
          : sale.quoteOwner && nameById.has(sale.quoteOwner)
            ? sale.quoteOwner
            : undefined;
      if (userId) return { key: `user:${userId}`, label: nameById.get(userId)! };
      if (sale.quoteOwnerLabel) return { key: `crm:${sale.quoteOwnerLabel.toLowerCase()}`, label: sale.quoteOwnerLabel };
      return sale.quoteOwner ? { key: '__unlinked__', label: UNLINKED_OWNER } : { key: '__none__', label: 'No owner on the quotation' };
    });
  }
}
