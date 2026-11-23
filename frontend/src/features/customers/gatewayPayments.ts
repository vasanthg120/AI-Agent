import type { GatewayPaymentRecord } from '@/services/customersService';

// Square amounts are minor units; these currencies have no minor unit.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);

/** Minor units → major units for display, respecting zero-decimal currencies. */
export function minorToMajor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? amount : amount / 100;
}

/** Fees and net, in the payment's own currency only. Null when there are no fees or any fee is in another currency. */
export function netReceived(p: GatewayPaymentRecord): { feeTotal: number; net: number } | null {
  const fees = p.details?.processingFees;
  if (!fees?.length) return null;
  if (fees.some((f) => f.currency.toUpperCase() !== p.currency.toUpperCase())) return null;
  const feeTotal = fees.reduce((sum, f) => sum + f.amount, 0);
  return { feeTotal, net: p.amount - feeTotal };
}

/** Square receipts open only when they are https pages on a Square domain. */
export function isSafeReceiptUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && ['squareup.com', 'square.site', 'squareupsandbox.com', 'squareupstaging.com'].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Case-insensitive match across the fields a person would search a payment by. */
export function matchesPaymentSearch(p: GatewayPaymentRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.id, p.status, p.currency, p.paymentMethodType, p.transactionReference, p.orderReference, p.details?.card?.brand, p.details?.card?.last4, p.details?.receiptNumber, p.links?.customerName]
    .some((v) => !!v && v.toLowerCase().includes(q));
}

/** Per-currency totals of the rows given (completed/refunded only count as paid); currencies are never mixed. */
export function totalsByCurrency(payments: GatewayPaymentRecord[]): { currency: string; paid: number; refunded: number; net: number; count: number }[] {
  const map = new Map<string, { currency: string; paid: number; refunded: number; net: number; count: number }>();
  for (const p of payments) {
    const row = map.get(p.currency) ?? { currency: p.currency, paid: 0, refunded: 0, net: 0, count: 0 };
    row.count += 1;
    if (p.status === 'completed' || p.status === 'partially_refunded' || p.status === 'refunded') {
      row.paid += p.amount;
      row.refunded += p.refundedAmount;
      row.net = row.paid - row.refunded;
    }
    map.set(p.currency, row);
  }
  return [...map.values()];
}

export const SOURCE_LABEL: Record<string, string> = { CARD: 'Card', CASH: 'Cash', BANK_ACCOUNT: 'Bank', WALLET: 'Wallet', BUY_NOW_PAY_LATER: 'Buy now, pay later', SQUARE_ACCOUNT: 'Square account', EXTERNAL: 'External' };

/** "VISA ····1111" when Square sent card info, else the payment source ("Cash", "Wallet"…), else a dash. */
export function cardLabel(p: GatewayPaymentRecord): string {
  const card = p.details?.card;
  if (card?.brand) return `${card.brand}${card.last4 ? ` ····${card.last4}` : ''}`;
  if (p.paymentMethodType) return SOURCE_LABEL[p.paymentMethodType.toUpperCase()] ?? p.paymentMethodType;
  return '—';
}

/** The gateway's real name ("Square"); an unknown provider keeps its own recorded name — never a generic label. */
export function providerLabel(provider: string): string {
  const known: Record<string, string> = { square: 'Square', stripe: 'Stripe' };
  return known[provider.toLowerCase()] ?? provider;
}
