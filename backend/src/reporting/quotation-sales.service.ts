import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

type Doc = Record<string, any>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** One quotation as the reports count it: its own value, and the tax written on it. */
export interface QuotationSale {
  id: string;
  number?: string;
  /** The company the quotation is for; failing that the contact; failing that the quotation's own name. */
  customer: string;
  /** The quotation's own date: which period it counts in. */
  date: Date;
  /** The customer has approved it. */
  accepted: boolean;
  dealId?: string;
  ownerUserId?: string;
  quoteOwner?: string;
  quoteOwnerLabel?: string;
  /** The quotation's amount — what the customer is asked to pay. */
  salesIncTax: number;
  /** The tax lines of the quotation, added up. */
  tax: number;
  /** The amount less its tax. */
  salesExTax: number;
  /** Whether the quotation carries a tax figure at all (one without is counted with no tax to take off). */
  taxRecorded: boolean;
}

export interface QuotationTotals {
  quotations: number;
  accepted: number;
  /** Quotations that carry no tax figure. */
  withoutTax: number;
  salesExTax: number;
  tax: number;
  salesIncTax: number;
}

export const NO_CUSTOMER = 'No customer on the quotation';

/**
 * What a stored quotation says about itself. A quotation's amount includes its tax; the tax is the sum of
 * its tax lines (as the CRM sync stores them) or, for a quotation written in HaiVE, its own tax amount.
 */
export function quotationSale(doc: Doc): QuotationSale {
  const amount = Math.max(0, num(doc.quoteAmount));
  const lines: Doc[] = Array.isArray(doc.taxes) ? doc.taxes : [];
  const fromLines = lines.reduce((sum, line) => sum + Math.max(0, num(line?.amount)), 0);
  const own = Math.max(0, num(doc.taxAmount));
  // Never more tax than the quotation is worth.
  const tax = Math.min(amount, lines.length > 0 ? fromLines : own);
  const client = (doc.clientDetails ?? {}) as Doc;
  return {
    id: String(doc._id),
    number: text(doc.quoteNumber) || undefined,
    customer: text(client.companyName) || text(client.contactName) || text(doc.quoteName) || NO_CUSTOMER,
    date: doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt),
    accepted: doc.clientApprovalStatus === 'approved',
    dealId: text(doc.dealId) || undefined,
    ownerUserId: text(doc.ownerUserId) || undefined,
    quoteOwner: text(doc.quoteOwner) || undefined,
    quoteOwnerLabel: text(doc.quoteOwnerLabel) || undefined,
    salesIncTax: round2(amount),
    tax: round2(tax),
    salesExTax: round2(amount - tax),
    taxRecorded: lines.length > 0 || own > 0,
  };
}

export function totalsOf(sales: QuotationSale[]): QuotationTotals {
  return {
    quotations: sales.length,
    accepted: sales.filter((s) => s.accepted).length,
    withoutTax: sales.filter((s) => !s.taxRecorded).length,
    salesExTax: round2(sales.reduce((sum, s) => sum + s.salesExTax, 0)),
    tax: round2(sales.reduce((sum, s) => sum + s.tax, 0)),
    salesIncTax: round2(sales.reduce((sum, s) => sum + s.salesIncTax, 0)),
  };
}

/** How the reports say what they counted — the same sentence on all three. */
export function countedNote(totals: QuotationTotals): string {
  if (totals.quotations === 0) return 'No quotation was sent in this period.';
  const one = totals.quotations === 1;
  const parts = [
    `Counted: ${one ? 'the 1 quotation' : `all ${totals.quotations} quotations`} sent in this period, by the quotation’s date — ${totals.accepted} accepted by the customer, ${totals.quotations - totals.accepted} not accepted yet. Drafts are left out.`,
    'The value and the tax are the quotation’s own: its amount includes tax, and “excluding tax” is that amount less its tax lines.',
  ];
  if (totals.withoutTax > 0)
    parts.push(
      `${totals.withoutTax} of them ${totals.withoutTax === 1 ? 'carries' : 'carry'} no tax line, so nothing is taken off ${totals.withoutTax === 1 ? 'its' : 'their'} amount.`,
    );
  return parts.join(' ');
}

// The one definition of "sales" the Sales, Gross Margin and Royalty reports
// share: every quotation that has been sent (anything but a draft) and whose
// own date falls in the period — whether or not the customer has accepted it
// yet. The value and the tax come from the quotation itself; no invoice and
// no cost is involved. Read straight from HaiVE's own copy of the quotations
// (filled by the CRM sync and by quotations written in HaiVE), always by
// organization.
//
// Depends on nothing but the database connection, so each module that needs
// it lists it in its own providers (as GridFsService is).
@Injectable()
export class QuotationSalesService {
  constructor(@InjectConnection() private connection: Connection) {}

  async sent(organizationId: string, dateFrom: string, dateTo: string, storeConstraint?: string): Promise<QuotationSale[]> {
    const match: Doc = {
      organizationId,
      quoteStatus: { $ne: 'draft' },
      // Whole days, end of the last one included.
      createdAt: { $gte: new Date(dateFrom), $lte: new Date(`${dateTo}T23:59:59.999Z`) },
    };
    // A quotation has no store of its own: it belongs to its deal's.
    if (storeConstraint) {
      const deals = await this.connection
        .collection('crm_deals')
        .find({ organizationId, storeId: storeConstraint }, { projection: { _id: 1 } })
        .toArray();
      match.dealId = { $in: deals.map((d) => d._id.toString()) };
    }
    const docs = await this.connection
      .collection('crm_quotes')
      .find(match, {
        projection: {
          quoteNumber: 1,
          quoteName: 1,
          quoteAmount: 1,
          taxes: 1,
          taxAmount: 1,
          clientApprovalStatus: 1,
          clientDetails: 1,
          dealId: 1,
          ownerUserId: 1,
          quoteOwner: 1,
          quoteOwnerLabel: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(quotationSale);
  }

  /** Who owns the deal each quotation was raised from. */
  async dealOwners(organizationId: string, sales: QuotationSale[]): Promise<Map<string, string>> {
    const ids = [...new Set(sales.map((s) => s.dealId).filter((id): id is string => !!id && Types.ObjectId.isValid(id)))];
    if (ids.length === 0) return new Map();
    const deals = await this.connection
      .collection('crm_deals')
      .find({ organizationId, _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { ownerId: 1 } })
      .toArray();
    return new Map(deals.filter((d) => text(d.ownerId)).map((d) => [d._id.toString(), text(d.ownerId)]));
  }
}
