import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { sourceCondition } from '../data-sources/data-source-scope.plugin';
import { scopeCurrency } from '../data-sources/scope-currency';

type Doc = Record<string, any>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** One won deal as the reports count it: its value, split into tax and the rest as on its quotations. */
export interface WonSale {
  /** The deal's id. */
  id: string;
  dealName: string;
  /** The numbers of the quotations its tax split is read from, e.g. "113, 108". */
  quoteNumbers?: string;
  /** The company on its latest quotation; failing that the contact; failing that the deal's own name. */
  customer: string;
  /** The day the deal closed ("YYYY-MM-DD"): which period it counts in. */
  date: string;
  /** Who owns the deal in HaiVE. */
  dealOwnerId?: string;
  /** The owner of its latest quotation, as the CRM gives it. */
  quoteOwnerUserId?: string;
  quoteOwner?: string;
  quoteOwnerLabel?: string;
  /** The deal's value — what the customer pays, tax included. */
  salesIncTax: number;
  tax: number;
  salesExTax: number;
  /** Whether its quotations carry a tax figure at all (without one nothing is taken off). */
  taxRecorded: boolean;
}

export interface WonSalesTotals {
  deals: number;
  /** Won deals whose quotations carry no tax figure. */
  withoutTax: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
}

export const NO_CUSTOMER = 'No customer on the deal';

/** The tax written on a quotation: the sum of its tax lines (CRM sync) or its own tax amount (written in HaiVE). */
function quotationTax(quote: Doc): { amount: number; tax: number; recorded: boolean } {
  const amount = Math.max(0, num(quote.quoteAmount));
  const lines: Doc[] = Array.isArray(quote.taxes) ? quote.taxes : [];
  const fromLines = lines.reduce((sum, line) => sum + Math.max(0, num(line?.amount)), 0);
  const own = Math.max(0, num(quote.taxAmount));
  return { amount, tax: Math.min(amount, lines.length > 0 ? fromLines : own), recorded: lines.length > 0 || own > 0 };
}

/**
 * A won deal and the quotations raised for it, as one sale. The deal's value is the sale (the same figure
 * the Dashboard counts as revenue) — never its quotations added up, which would count a re-issued copy of
 * a quote twice. Its tax is in the same proportion as on the quotations the customer accepted (all of
 * them, if the CRM never marked one accepted).
 */
export function wonSale(deal: Doc, quotes: Doc[]): WonSale {
  const value = Math.max(0, num(deal.monetaryValue));
  const accepted = quotes.filter((q) => q.clientApprovalStatus === 'approved');
  const basis = (accepted.length > 0 ? accepted : quotes).slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const split = basis.map(quotationTax);
  const quoted = split.reduce((sum, s) => sum + s.amount, 0);
  const quotedTax = split.reduce((sum, s) => sum + s.tax, 0);
  const tax = quoted > 0 ? round2(value * Math.min(1, quotedTax / quoted)) : 0;
  const latest = basis[0] ?? {};
  const client = (latest.clientDetails ?? {}) as Doc;
  const numbers = [...new Set(basis.map((q) => text(q.quoteNumber)).filter(Boolean))];
  return {
    id: String(deal._id),
    dealName: text(deal.name),
    quoteNumbers: numbers.length ? numbers.join(', ') : undefined,
    customer: text(client.companyName) || text(client.contactName) || text(deal.name) || NO_CUSTOMER,
    date: text(deal.expectedClosingDate).slice(0, 10),
    dealOwnerId: text(deal.ownerId) || undefined,
    quoteOwnerUserId: text(latest.ownerUserId) || undefined,
    quoteOwner: text(latest.quoteOwner) || undefined,
    quoteOwnerLabel: text(latest.quoteOwnerLabel) || undefined,
    salesIncTax: round2(value),
    tax,
    salesExTax: round2(value - tax),
    taxRecorded: split.some((s) => s.recorded),
  };
}

export function totalsOf(sales: WonSale[]): WonSalesTotals {
  return {
    deals: sales.length,
    withoutTax: sales.filter((s) => !s.taxRecorded).length,
    salesExTax: round2(sales.reduce((sum, s) => sum + s.salesExTax, 0)),
    tax: round2(sales.reduce((sum, s) => sum + s.tax, 0)),
    salesIncTax: round2(sales.reduce((sum, s) => sum + s.salesIncTax, 0)),
  };
}

/** How the reports say what they counted — the same sentence on all three. */
export function countedNote(totals: WonSalesTotals): string {
  if (totals.deals === 0) return 'No deal was won in this period.';
  const one = totals.deals === 1;
  const parts = [
    `Counted: ${one ? 'the 1 deal' : `the ${totals.deals} deals`} won in this period, by the day each closed, at the deal’s value — the same as the Dashboard’s revenue. Quotations not won are left out.`,
    'Tax is split as on each deal’s quotations; “excluding tax” is the value less that tax.',
  ];
  if (totals.withoutTax > 0)
    parts.push(
      `${totals.withoutTax} of them ${totals.withoutTax === 1 ? 'has' : 'have'} no tax on ${totals.withoutTax === 1 ? 'its' : 'their'} quotations, so nothing is taken off.`,
    );
  return parts.join(' ');
}

/** The day after a "YYYY-MM-DD" date, as the same kind of string. */
function dayAfter(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The one definition of "sales" the Sales, Gross Margin and Royalty reports
// share (since 2026-11-10, the user's choice): the deals WON in the period —
// by the day each closed (expectedClosingDate, set to the real day when a deal
// is won), at the deal's own value. That is exactly the Dashboard's revenue,
// so the two never disagree. Before, every quotation sent in the period
// counted, accepted or not — the reports showed everything ever quoted.
//
// Like the dashboards, it reads the CRM the request shows (the one chosen for
// dashboards, through the data-source scope) — never two CRMs added together,
// whose amounts may be in different currencies (Pantheras INR, Hoops AUD).
// Two queries: the won deals, then their quotations (for the tax split and
// the customer's name).
@Injectable()
export class WonSalesService {
  constructor(@InjectConnection() private connection: Connection) {}

  async won(organizationId: string, dateFrom: string, dateTo: string, storeConstraint?: string): Promise<WonSale[]> {
    const match: Doc = {
      organizationId,
      dealStatus: 'won',
      // Whole days, the last one included ("YYYY-MM-DD" strings compare as text).
      expectedClosingDate: { $gte: dateFrom, $lt: dayAfter(dateTo) },
      ...(storeConstraint ? { storeId: storeConstraint } : {}),
    };
    const scoped = sourceCondition(match);
    const deals = await this.connection
      .collection('crm_deals')
      .find(scoped ? { ...match, $and: [scoped] } : match, {
        projection: { name: 1, monetaryValue: 1, expectedClosingDate: 1, ownerId: 1 },
      })
      .sort({ expectedClosingDate: -1 })
      .toArray();
    if (deals.length === 0) return [];

    const quotes = await this.connection
      .collection('crm_quotes')
      .find(
        { organizationId, dealId: { $in: deals.map((d) => d._id.toString()) }, quoteStatus: { $nin: ['draft', 'voided'] } },
        {
          projection: {
            dealId: 1,
            quoteNumber: 1,
            quoteAmount: 1,
            taxes: 1,
            taxAmount: 1,
            clientApprovalStatus: 1,
            clientDetails: 1,
            ownerUserId: 1,
            quoteOwner: 1,
            quoteOwnerLabel: 1,
            createdAt: 1,
          },
        },
      )
      .toArray();
    const byDeal = new Map<string, Doc[]>();
    for (const q of quotes) {
      const key = String(q.dealId);
      if (!byDeal.has(key)) byDeal.set(key, []);
      byDeal.get(key)!.push(q);
    }
    return deals.map((deal) => wonSale(deal, byDeal.get(deal._id.toString()) ?? []));
  }

  /** What the sales in scope are priced in: the shown CRM's currency (Hoops: AUD), else INR. */
  currency(organizationId: string): Promise<string> {
    return scopeCurrency(this.connection, organizationId);
  }
}
