// The ONE place a quote's payment status is computed. Customers, quote/invoice documents, the order list, the payment
// summary and the SalesBoard all read this, so they can never disagree. Pure: no I/O, derived fresh from the linked
// payments of EVERY connected source — never from the CRM's word alone — so a CRM that still says "Not Paid" can never
// hide a verified payment, and a refund can never leave a quote stuck on "Paid".
//
// Three kinds of evidence, never mixed up:
//  - verified: a transaction a provider (Square, …) or an itemized payment record states, with an id, amount and date;
//  - recorded: money a person recorded against the quote (itemized records, or the quote's running paid total);
//  - CRM-reported: only a status word from a CRM ("Paid", "50% Paid"). Preserved and shown as source-reported, and never
//    used to LOWER a verified amount.

import { CrmPaymentReport, crmReportedAmount } from './crm-payment-report';

export type QuotePaymentStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overpaid';

/** Only what the calculation reads of a normalized provider payment (structurally a GatewayPaymentRecord). Minor units. */
export interface QuotePaymentInput {
  id: string;
  provider: string;
  amount: number;
  currency: string;
  status: string;
  date: Date;
  refundedAmount: number;
  paymentMethodType?: string;
  transactionReference?: string;
  orderReference?: string;
  details?: { receiptUrl?: string; squareInvoiceNumber?: string; squareInvoiceTitle?: string; referenceId?: string };
  links?: { quote?: { id: string } };
}

/** An itemized payment someone recorded against the quote (Haive's quote payments, a remittance, …). Major units. */
export interface RecordedPaymentInput {
  id: string;
  amount: number;
  date: Date;
  method?: string;
  reference?: string;
  currency?: string;
}

export interface QuotePaymentTransaction {
  id: string;
  /** Provider display name ("Square"), or "Remittance"/"Recorded" for an itemized record. */
  source: string;
  kind: 'gateway' | 'recorded';
  /** Major units, in `currency`. */
  amount: number;
  refunded: number;
  net: number;
  currency: string;
  date: Date;
  method?: string;
  reference?: string;
  receiptUrl?: string;
  /** Counted toward the paid amount. A payment found to be the same money as another is listed but flagged. */
  counted: boolean;
  duplicateOf?: string;
}

export interface QuotePaymentSource {
  name: string;
  /** True when a real transaction/itemized record backs it; false when it is only what a CRM reported. */
  verified: boolean;
}

export interface QuotePaymentSummary {
  quoteId: string;
  quoteNumber?: string;
  currency: string;
  quoteTotal: number;
  /** Successful payments minus refunds (plus recorded/CRM-reported money not covered by those), major units, quote currency only. */
  paidAmount: number;
  outstandingAmount: number;
  status: QuotePaymentStatus;
  /** What transactions/records alone prove (major units); `paidAmount` may exceed it only by CRM-reported money. */
  verifiedPaid: number;
  /** Money only a CRM/recorded total states, with no transaction behind it (major units). */
  reportedPaid: number;
  /** 'verified' — transactions prove it; 'reported' — only the CRM/recorded total says so; 'mixed'; 'none'. */
  basis: 'verified' | 'reported' | 'mixed' | 'none';
  /** Provider display name(s) of the gateway payments counted, e.g. "Square". */
  gateway?: string;
  /** Every source that contributed — verified providers/records first, then CRM-reported ones. */
  sources: QuotePaymentSource[];
  paymentMethod?: string;
  paymentDate?: Date;
  transactionReference?: string;
  /** Provider payment ids that were counted (each once). */
  transactionIds: string[];
  transactions: QuotePaymentTransaction[];
  /** Total refunded across counted payments (major units). */
  refundedAmount: number;
  /** What the CRM said, kept apart from the verified figures above. */
  crmReported?: { source?: string; state: string; percentPaid?: number; raw: string[]; methods: string[]; gatewayHints: string[] };
  /** The CRM says less than what is verified (e.g. Hoops "Not Paid", Square paid) — Haive's verified figure wins. */
  crmOutdated: boolean;
  /** The CRM says more than is verified (e.g. Hoops "Paid", no transaction) — preserved, flagged unverified. */
  crmUnverified: boolean;
}

/** Square statuses whose money was really taken. Pending, authorized, failed and cancelled never count. */
const SETTLED = new Set(['completed', 'partially_refunded', 'refunded']);
const PROVIDER_LABEL: Record<string, string> = { square: 'Square', stripe: 'Stripe' };
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (v?: string) => (v ?? '').trim().toLowerCase();
const DAY = 86_400_000;

export const providerLabel = (provider: string) => PROVIDER_LABEL[provider.toLowerCase()] ?? provider;

/** Status from the two numbers, in the order the business rules state them. */
export function quotePaymentStatus(paidAmount: number, quoteTotal: number): QuotePaymentStatus {
  const paid = round2(paidAmount);
  const total = round2(quoteTotal);
  if (paid <= 0) return 'unpaid';
  if (paid > total) return 'overpaid';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

export const QUOTE_PAYMENT_LABEL: Record<QuotePaymentStatus, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
};

/** Verified money V and source-stated money R describe the same payments, or different ones. Never double counted:
 *  V + R = the quote total exactly → two halves of one quote (Hoops "50% Paid" + a Square payment of the remaining
 *  50%) — when V != R, or when V == R but every verified payment is dated AFTER the CRM last changed (so the CRM cannot
 *  have been describing it); otherwise equal → the same money; anything else → the larger one. */
export function combinePaid(verified: number, reported: number, total: number, verifiedAfterCrm = false): number {
  if (reported <= 0) return verified;
  if (verified <= 0) return reported;
  const halves = Math.abs(verified + reported - total) <= 0.01;
  if (Math.abs(verified - reported) <= 0.01) return halves && verifiedAfterCrm ? verified + reported : verified;
  if (halves) return verified + reported;
  return Math.max(verified, reported);
}

export function summarizeQuotePayment(input: {
  quoteId: string;
  quoteNumber?: string;
  quoteTotal: number;
  currency: string;
  /** Every provider payment of this customer/org; only those LINKED to this quote (by an exact identifier) are counted. */
  gatewayPayments: QuotePaymentInput[];
  /** The quote's running recorded total (major units, e.g. the CRM's/Haive's paid amount). May describe the very same
   * money as a gateway payment, so it is never added to it blindly (see combinePaid). */
  recordedPaid?: number;
  /** Itemized payments recorded against this quote (remittance, manual …). Deduplicated against the gateway payments. */
  recordedPayments?: RecordedPaymentInput[];
  /** What the CRM says about this quote's payment (status words). Informational/unverified. */
  crmReport?: CrmPaymentReport;
  /** Display name of the CRM the report came from ("Hoops"). */
  crmSource?: string;
  /** When the CRM record last changed (its own date, e.g. Hoops' last activity). Lets a verified payment made after it be
   * told apart from the money the CRM already reports. */
  crmChangedAt?: Date;
}): QuotePaymentSummary {
  const currency = input.currency.toUpperCase();
  const seen = new Set<string>();
  const transactions: QuotePaymentTransaction[] = [];
  const counted = input.gatewayPayments
    .filter((p) => p.links?.quote?.id === input.quoteId)
    // Currencies are never combined: a payment in another currency is not part of this quote's balance.
    .filter((p) => p.currency.toUpperCase() === currency)
    .filter((p) => SETTLED.has(p.status))
    // A webhook, a sync and a reconciliation all land on one provider payment id; it counts once.
    .filter((p) => {
      const key = `${p.provider}:${p.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  for (const p of counted) {
    const net = Math.max(p.amount - p.refundedAmount, 0) / 100;
    transactions.push({
      id: p.id,
      source: providerLabel(p.provider),
      kind: 'gateway',
      amount: p.amount / 100,
      refunded: p.refundedAmount / 100,
      net,
      currency,
      date: p.date,
      ...(p.paymentMethodType ? { method: p.paymentMethodType } : {}),
      ...((p.transactionReference ?? p.orderReference) ? { reference: p.transactionReference ?? p.orderReference } : {}),
      ...(p.details?.receiptUrl ? { receiptUrl: p.details.receiptUrl } : {}),
      counted: true,
    });
  }
  const gatewayNet = transactions.reduce((sum, t) => sum + t.net, 0);

  // Itemized records: the same money as a gateway payment when they share an exact identifier, or — both already tied
  // to THIS quote — the same amount on (almost) the same day. Anything else is a genuine separate payment.
  const gatewayKeys = (p: QuotePaymentInput) =>
    [p.id, p.transactionReference, p.orderReference, p.details?.referenceId, p.details?.squareInvoiceNumber, p.details?.squareInvoiceTitle].map(norm).filter(Boolean);
  const paired = new Set<string>();
  const recordedSeen = new Set<string>();
  let recordedItemizedAll = 0;
  let recordedCounted = 0;
  for (const r of input.recordedPayments ?? []) {
    if (recordedSeen.has(r.id)) continue;
    recordedSeen.add(r.id);
    if (r.currency && r.currency.toUpperCase() !== currency) continue;
    recordedItemizedAll += r.amount;
    const byReference = r.reference ? counted.find((p) => gatewayKeys(p).includes(norm(r.reference))) : undefined;
    const byAmountDate = byReference
      ? undefined
      : counted.find((p) => !paired.has(p.id) && Math.abs(Math.max(p.amount - p.refundedAmount, 0) / 100 - r.amount) <= 0.01 && Math.abs(p.date.getTime() - r.date.getTime()) <= 2 * DAY);
    const twin = byReference ?? byAmountDate;
    if (twin) paired.add(twin.id);
    const remittance = /remit/i.test(r.method ?? '');
    transactions.push({
      id: r.id,
      source: remittance ? 'Remittance' : 'Recorded',
      kind: 'recorded',
      amount: r.amount,
      refunded: 0,
      net: r.amount,
      currency,
      date: r.date,
      ...(r.method ? { method: r.method } : {}),
      ...(r.reference ? { reference: r.reference } : {}),
      counted: !twin,
      ...(twin ? { duplicateOf: twin.id } : {}),
    });
    if (!twin) recordedCounted += r.amount;
  }

  const verifiedPaid = round2(gatewayNet + recordedCounted);
  // Money only a lump total / CRM word states: the quote's running recorded total beyond the itemized records, or a CRM "Paid"/"50% Paid".
  const lump = Math.max((input.recordedPaid ?? 0) - recordedItemizedAll, 0);
  const crmAmount = crmReportedAmount(input.crmReport, input.quoteTotal);
  const reported = Math.max(lump, crmAmount);
  const verifiedDates = transactions.filter((t) => t.counted).map((t) => t.date.getTime());
  const verifiedAfterCrm = !!input.crmChangedAt && verifiedDates.length > 0 && verifiedDates.every((d) => d > input.crmChangedAt!.getTime());
  const paidAmount = round2(combinePaid(verifiedPaid, reported, input.quoteTotal, verifiedAfterCrm));
  const reportedPaid = round2(Math.max(paidAmount - verifiedPaid, 0));
  const basis: QuotePaymentSummary['basis'] = paidAmount <= 0 ? 'none' : reportedPaid <= 0 ? 'verified' : verifiedPaid <= 0 ? 'reported' : 'mixed';

  const crmState = input.crmReport?.state ?? 'unknown';
  const crmSaysPaid = crmState === 'paid' || crmState === 'partially_paid';
  const crmOutdated = verifiedPaid > 0 && (crmState === 'unpaid' || (crmState === 'unknown' ? false : crmAmount + 0.01 < verifiedPaid));
  const crmUnverified = crmAmount > verifiedPaid + 0.01 && crmSaysPaid;

  const newest = [...transactions].filter((t) => t.counted).sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  const gateways = [...new Set(counted.map((p) => providerLabel(p.provider)))];
  const sources: QuotePaymentSource[] = [];
  const addSource = (name: string, verified: boolean) => {
    const existing = sources.find((s) => s.name === name);
    if (existing) existing.verified = existing.verified || verified;
    else sources.push({ name, verified });
  };
  for (const t of transactions) if (t.counted) addSource(t.source, true);
  if (reportedPaid > 0 || (crmSaysPaid && verifiedPaid <= 0)) {
    if (input.crmReport?.methods.includes('Remittance')) addSource('Remittance', false);
    else if (input.crmSource) addSource(input.crmSource, false);
    for (const g of input.crmReport?.gatewayHints ?? []) if (!sources.some((s) => s.name === g)) addSource(g, false);
  }
  if (sources.length === 0 && reportedPaid > 0 && input.crmSource) addSource(input.crmSource, false);

  return {
    quoteId: input.quoteId,
    quoteNumber: input.quoteNumber,
    currency,
    quoteTotal: round2(input.quoteTotal),
    paidAmount,
    outstandingAmount: round2(Math.max(input.quoteTotal - paidAmount, 0)),
    status: quotePaymentStatus(paidAmount, input.quoteTotal),
    verifiedPaid,
    reportedPaid,
    basis,
    ...(gateways.length ? { gateway: gateways.join(', ') } : {}),
    sources,
    ...(newest?.method ? { paymentMethod: newest.method } : {}),
    ...(newest ? { paymentDate: newest.date } : {}),
    ...(newest?.reference ? { transactionReference: newest.reference } : {}),
    transactionIds: counted.map((p) => p.id),
    transactions,
    refundedAmount: round2(transactions.filter((t) => t.counted).reduce((sum, t) => sum + t.refunded, 0)),
    ...(input.crmReport && input.crmReport.raw.length
      ? { crmReported: { ...(input.crmSource ? { source: input.crmSource } : {}), state: input.crmReport.state, ...(input.crmReport.percentPaid !== undefined ? { percentPaid: input.crmReport.percentPaid } : {}), raw: input.crmReport.raw, methods: input.crmReport.methods, gatewayHints: input.crmReport.gatewayHints } }
      : {}),
    crmOutdated,
    crmUnverified,
  };
}
