// What a CRM (Hoops today) SAYS about a quote's payment — kept strictly apart from verified payments. A CRM word is
// a report, not a transaction: "Square" names a gateway, never proves a charge; "Remittance" names a method, never a
// gateway; "Not Paid" is only the CRM's last word and never lowers a verified payment. Pure: no I/O.

export type CrmReportedState = 'unpaid' | 'partially_paid' | 'paid' | 'unknown';

export interface CrmPaymentReport {
  /** Every raw CRM text this was read from (status words, payment labels), for display and audit. */
  raw: string[];
  /** What the CRM says about how far it is paid. 'unknown' when the words say nothing about that. */
  state: CrmReportedState;
  /** "50% Paid" → 50. Only when the CRM states a percentage. */
  percentPaid?: number;
  /** Payment methods the CRM names (e.g. "Remittance", "Bank transfer"). A method — never a gateway, never an amount. */
  methods: string[];
  /** Gateways the CRM names (e.g. "Square"). A pointer for investigation only — NOT proof a transaction exists. */
  gatewayHints: string[];
}

const METHOD_WORDS: [RegExp, string][] = [
  [/\bremit+ance\b/i, 'Remittance'],
  [/\b(bank transfer|wire transfer|eft|bacs|direct deposit)\b/i, 'Bank transfer'],
  [/\bcheque\b|\bcheck\b/i, 'Cheque'],
  [/\bcash\b/i, 'Cash'],
];
/** Gateway names are looked up, never assumed: a provider is a hint only when the CRM text names it. */
const GATEWAY_WORDS: [RegExp, string][] = [
  [/\bsquare\b/i, 'Square'],
  [/\bstripe\b/i, 'Stripe'],
  [/\bpaypal\b/i, 'PayPal'],
];

/** One CRM word/phrase → what it states. Order matters: "not paid" and "unpaid" must win over "paid". */
export function classifyCrmPaymentText(value: unknown): Pick<CrmPaymentReport, 'state' | 'percentPaid' | 'methods' | 'gatewayHints'> {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const out: Pick<CrmPaymentReport, 'state' | 'percentPaid' | 'methods' | 'gatewayHints'> = { state: 'unknown', methods: [], gatewayHints: [] };
  if (!text) return out;
  for (const [pattern, label] of METHOD_WORDS) if (pattern.test(text)) out.methods.push(label);
  for (const [pattern, label] of GATEWAY_WORDS) if (pattern.test(text)) out.gatewayHints.push(label);
  const percent = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:paid|deposit|received)?/i.exec(text);
  if (/\b(not\s+paid|unpaid|awaiting\s+payment|payment\s+pending|no\s+payment)\b/i.test(text)) out.state = 'unpaid';
  else if (percent && /paid|deposit|received/i.test(text)) {
    const pct = Math.min(Number(percent[1]), 100);
    out.percentPaid = pct;
    out.state = pct >= 100 ? 'paid' : pct > 0 ? 'partially_paid' : 'unpaid';
  } else if (/\b(part(ially)?[\s-]*paid|deposit\s+paid|partial\s+payment)\b/i.test(text)) out.state = 'partially_paid';
  else if (/\b(fully\s+paid|paid\s+in\s+full|paid)\b/i.test(text)) out.state = 'paid';
  return out;
}

/** Combines every CRM text that talks about this quote's payment. A "paid" word beats "unknown"; contradictory words
 * (one says paid, another not paid) keep the most informative reading and stay visible in `raw`. */
export function readCrmPaymentReport(texts: unknown[]): CrmPaymentReport {
  const raw = [...new Set(texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()))];
  const report: CrmPaymentReport = { raw, state: 'unknown', methods: [], gatewayHints: [] };
  const rank: Record<CrmReportedState, number> = { unknown: 0, unpaid: 1, partially_paid: 2, paid: 3 };
  for (const text of raw) {
    const read = classifyCrmPaymentText(text);
    if (rank[read.state] > rank[report.state]) {
      report.state = read.state;
      report.percentPaid = read.percentPaid;
    }
    for (const m of read.methods) if (!report.methods.includes(m)) report.methods.push(m);
    for (const g of read.gatewayHints) if (!report.gatewayHints.includes(g)) report.gatewayHints.push(g);
  }
  return report;
}

/** The amount (major units) the CRM's words alone state, when they state one: "Paid" → the total, "50% Paid" → half. Never invented for "Remittance"/"Square". */
export function crmReportedAmount(report: CrmPaymentReport | undefined, quoteTotal: number): number {
  if (!report || quoteTotal <= 0) return 0;
  if (report.state === 'paid') return quoteTotal;
  if (report.state === 'partially_paid' && typeof report.percentPaid === 'number') return Math.round(quoteTotal * report.percentPaid) / 100;
  return 0;
}
