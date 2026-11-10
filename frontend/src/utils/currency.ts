import { useCurrencyStore } from '@/stores/currencyStore';

// The sales/deals domain's amounts are in the currency of the CRM shown on the
// dashboards (Pantheras CRM: INR, Hoops CRM: AUD — see stores/currencyStore).
// Each is written the way its country writes it: 'en-IN' gives the lakh/crore
// digit grouping (10,00,000), 'en-AU' the thousands one (1,000,000).
const SALES_SYMBOL: Record<string, string> = { INR: '₹', AUD: 'A$', NZD: 'NZ$', USD: '$', GBP: '£', EUR: '€' };
const SALES_LOCALE: Record<string, string> = { INR: 'en-IN', AUD: 'en-AU', NZD: 'en-NZ', GBP: 'en-GB' };

const salesCurrency = () => useCurrencyStore.getState().currency || 'INR';

/** The shown CRM's currency symbol (₹, A$…) — for amount fields. */
export function currencySymbol(): string {
  const code = salesCurrency();
  return SALES_SYMBOL[code] ?? code;
}

function salesAmount(value: number, options: Intl.NumberFormatOptions): string {
  const code = salesCurrency();
  const number = value.toLocaleString(SALES_LOCALE[code] ?? 'en-US', options);
  return SALES_SYMBOL[code] ? `${SALES_SYMBOL[code]}${number}` : `${code} ${number}`;
}

// Whole units, in the shown CRM's currency (the name stays from when it was always rupees).
export function formatINR(value: number | null): string {
  if (value === null) return '—';
  return salesAmount(value, { maximumFractionDigits: 0 });
}

// An amount in a currency named explicitly (e.g. a quote's own currency,
// which need not be the dashboard's), written the way that country writes
// it; the fraction only when there is one.
export function formatAmountIn(value: number | null, currency: string): string {
  if (value === null) return '—';
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  const number = Math.abs(value).toLocaleString(SALES_LOCALE[currency] ?? 'en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const sign = value < 0 ? '−' : '';
  return SALES_SYMBOL[currency] ? `${sign}${SALES_SYMBOL[currency]}${number}` : `${sign}${currency} ${number}`;
}

// For reports, where figures are added up in front of the reader (sales
// excluding tax + tax = sales including tax; a royalty owed to the paisa/cent):
// the fraction is shown whenever an amount has one, never rounded away.
export function formatINRExact(value: number | null): string {
  if (value === null) return '—';
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  return salesAmount(value, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
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
