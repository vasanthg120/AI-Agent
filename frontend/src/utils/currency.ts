// Sales targets/deals are always INR for this deployment (see
// backend/src/crm/schemas/sales-target.schema.ts's default) — 'en-IN' gives
// the correct lakh/crore digit grouping, not just the ₹ symbol.
export function formatINR(value: number | null): string {
  if (value === null) return '—';
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// Haive Credits billing (packages/payments) is NOT hardcoded to INR (see
// backend/src/config/configuration.ts's billing.currency) — this formats
// whatever currency code a given package/payment record actually carries,
// unlike formatINR above which is deliberately fixed to one currency for
// the unrelated sales/deals domain.
const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function formatCurrency(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  // Always 2 decimal places — a bare toLocaleString() drops them for a whole
  // number (99 -> "99") but keeps them for a converted figure (8217.34 ->
  // "8,217.34"), which reads as inconsistent precision on the same page.
  // Money is always shown to its minor unit, matching PricingService's own
  // 2-decimal rounding convention on the backend.
  const formattedAmount = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol}${formattedAmount}` : `${formattedAmount} ${currency.toUpperCase()}`;
}
