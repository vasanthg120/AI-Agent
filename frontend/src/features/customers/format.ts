export function formatDate(iso?: string): string {
  if (!iso) return 'Not available';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'Not available'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** An amount in the quotation's own currency (HaiVE quotes carry one; INR when they don't).
 * Whole amounts show no decimals, and rupees are grouped the Indian way — the
 * same way the backend words amounts inside its sentences. */
export function formatMoney(amount: number, currency?: string): string {
  const code = currency || 'INR';
  try {
    return new Intl.NumberFormat(code === 'INR' ? 'en-IN' : undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString()}`.trim();
  }
}

// A status as the CRM stores it ("approved", "in_review") in the way the rest of the page reads.
export function sentenceCase(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}
