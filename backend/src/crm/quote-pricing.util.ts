import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';

// Pure, DB-free pricing math for native Quote line items — the backend is
// always the source of truth (a client-sent total is never trusted; see
// quotes.service.ts's createQuote/updateQuote, which always recompute via
// this file). Rounding follows the exact convention already established in
// billing/pricing.service.ts: 2 decimal places, ROUND_HALF_UP.

export interface QuoteItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export interface ComputedQuoteItem extends QuoteItemInput {
  discount: number;
  taxRate: number;
  lineSubtotal: number;
  lineTotal: number;
}

export interface QuoteTotals {
  items: ComputedQuoteItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  quoteAmount: number;
}

function round2(value: Decimal): number {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

// Per-line item calculation rules (applied per line, then summed at the
// quote level — see the plan's reconciliation note for why the request's
// per-line item shape and its quote-level formula aren't actually in
// conflict):
//   lineSubtotal = quantity * unitPrice
//   lineDiscounted = lineSubtotal - discount
//   lineTax = lineDiscounted * (taxRate / 100)
//   lineTotal = lineDiscounted + lineTax
export function calculateLineItem(item: QuoteItemInput): ComputedQuoteItem {
  const discount = item.discount ?? 0;
  const taxRate = item.taxRate ?? 0;
  const quantity = new Decimal(item.quantity);
  const unitPrice = new Decimal(item.unitPrice);
  const lineSubtotalDecimal = quantity.times(unitPrice);
  const lineDiscounted = lineSubtotalDecimal.minus(discount);
  const lineTax = lineDiscounted.times(new Decimal(taxRate).dividedBy(100));
  const lineTotal = lineDiscounted.plus(lineTax);

  return {
    ...item,
    discount,
    taxRate,
    lineSubtotal: round2(lineSubtotalDecimal),
    lineTotal: round2(lineTotal),
  };
}

export function calculateQuoteTotals(items: QuoteItemInput[]): QuoteTotals {
  const computed = items.map(calculateLineItem);
  let subtotal = new Decimal(0);
  let discountAmount = new Decimal(0);
  let taxAmount = new Decimal(0);
  let quoteAmount = new Decimal(0);

  for (const item of computed) {
    subtotal = subtotal.plus(item.lineSubtotal);
    discountAmount = discountAmount.plus(item.discount);
    const lineDiscounted = new Decimal(item.lineSubtotal).minus(item.discount);
    taxAmount = taxAmount.plus(new Decimal(item.lineTotal).minus(lineDiscounted));
    quoteAmount = quoteAmount.plus(item.lineTotal);
  }

  return {
    items: computed,
    subtotal: round2(subtotal),
    discountAmount: round2(discountAmount),
    taxAmount: round2(taxAmount),
    quoteAmount: round2(quoteAmount),
  };
}

// Throws a specific, actionable 400 on the first violation found — matches
// this codebase's convention of never silently clamping a bad financial
// input (see quotes.service.ts's own SYNC_OWNED_FIELDS rejection style).
export function validateQuoteItems(items: QuoteItemInput[]): void {
  if (!items || items.length === 0) {
    throw new BadRequestException('A quote needs at least one line item.');
  }
  items.forEach((item, index) => {
    const label = `Line item ${index + 1}`;
    if (!(item.quantity > 0)) {
      throw new BadRequestException(`${label}: quantity must be greater than zero.`);
    }
    if (item.unitPrice < 0) {
      throw new BadRequestException(`${label}: unit price cannot be negative.`);
    }
    const discount = item.discount ?? 0;
    if (discount < 0) {
      throw new BadRequestException(`${label}: discount cannot be negative.`);
    }
    const lineSubtotal = item.quantity * item.unitPrice;
    if (discount > lineSubtotal) {
      throw new BadRequestException(`${label}: discount cannot exceed the line subtotal.`);
    }
    const taxRate = item.taxRate ?? 0;
    if (taxRate < 0 || taxRate > 100) {
      throw new BadRequestException(`${label}: tax rate must be between 0 and 100.`);
    }
  });
}
