// Payment source adapters: each connected provider that holds payment TRANSACTIONS normalizes them into one common
// record, so the reconciliation never contains provider-specific calculations. The calculation
// (quote-payment-status.ts) only ever sees the normalized shape; which providers exist is decided here, by this
// registry, not by the calculation.
//
// A provider is added by registering one adapter (its collection → NormalizedPayment). Square is the only provider that
// stores payment transactions in Haive today; the Xero/MYOB/Zoho Books integrations here expose invoices and contacts
// but no payment transactions, so there is nothing to normalize for them yet — see the final report's limitations.

import type { Connection } from 'mongoose';
import type { SquarePaymentDetails } from '../square/square-payment-details';

type Doc = Record<string, unknown>;

/** The normalized provider payment. Minor currency units, like every gateway reports them. */
export interface NormalizedPayment {
  id: string;
  /** Provider key ("square"); labelled for display by providerLabel(). */
  provider: string;
  amount: number;
  currency: string;
  /** completed | partially_refunded | refunded | pending | authorized | failed | cancelled | … */
  status: string;
  date: Date;
  refundedAmount: number;
  paymentMethodType?: string;
  orderReference?: string;
  transactionReference?: string;
  details?: SquarePaymentDetails;
  /** Normalized customer identity keys the provider resolved (same keys customer-matching.ts produces). */
  matchedEmailKey?: string;
  matchedPhoneKey?: string;
  /** Provider-side invoice id, when the payment was billed through one (used to count invoice-linked payments). */
  invoiceId?: string;
  /** When the provider record was last refreshed in Haive. */
  lastSyncedAt?: Date;
}

export interface PaymentSourceAdapter {
  /** Provider key, matching the integration registry / credentials provider. */
  readonly provider: string;
  /** This organization's normalized payments from this provider. Always scoped to the organization. */
  load(connection: Connection, organizationId: string): Promise<NormalizedPayment[]>;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const asDate = (v: unknown): Date | undefined => {
  const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

/** Square: `square_payment_transactions`, written by the webhook and the reconciliation services. */
export const squarePaymentAdapter: PaymentSourceAdapter = {
  provider: 'square',
  async load(connection, organizationId) {
    const docs = (await connection
      .collection('square_payment_transactions')
      .find(
        { organizationId },
        {
          projection: {
            providerPaymentId: 1, matchedEmailKey: 1, matchedPhoneKey: 1, amount: 1, currency: 1, paymentStatus: 1, paymentDate: 1,
            refundedAmount: 1, provider: 1, paymentMethodType: 1, orderReference: 1, transactionReference: 1, details: 1, lastSyncedAt: 1,
          },
        },
      )
      .toArray()) as Doc[];
    return docs.flatMap((doc): NormalizedPayment[] => {
      const date = asDate(doc.paymentDate);
      if (!date) return [];
      const details = doc.details && typeof doc.details === 'object' ? (doc.details as SquarePaymentDetails) : undefined;
      return [
        {
          id: text(doc.providerPaymentId),
          provider: text(doc.provider) || 'square',
          amount: num(doc.amount),
          currency: text(doc.currency) || 'USD',
          status: text(doc.paymentStatus),
          date,
          refundedAmount: num(doc.refundedAmount),
          paymentMethodType: text(doc.paymentMethodType) || undefined,
          orderReference: text(doc.orderReference) || undefined,
          transactionReference: text(doc.transactionReference) || undefined,
          details,
          matchedEmailKey: text(doc.matchedEmailKey) || undefined,
          matchedPhoneKey: text(doc.matchedPhoneKey) || undefined,
          invoiceId: details?.squareInvoiceId,
          lastSyncedAt: asDate(doc.lastSyncedAt),
        },
      ];
    });
  },
};

/** Every adapter the reconciliation reads. Add a provider here; nothing else changes. */
export const PAYMENT_SOURCE_ADAPTERS: PaymentSourceAdapter[] = [squarePaymentAdapter];

/** All of an organization's payments from every registered source. A failing adapter never hides the others; its
 * failure is reported to the caller, never swallowed silently. */
export async function loadNormalizedPayments(
  connection: Connection,
  organizationId: string,
  adapters: PaymentSourceAdapter[] = PAYMENT_SOURCE_ADAPTERS,
): Promise<{ payments: NormalizedPayment[]; failures: { provider: string; error: string }[] }> {
  const results = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return { payments: await adapter.load(connection, organizationId), failure: undefined };
      } catch (err) {
        return { payments: [] as NormalizedPayment[], failure: { provider: adapter.provider, error: (err as Error).message } };
      }
    }),
  );
  return { payments: results.flatMap((r) => r.payments), failures: results.flatMap((r) => (r.failure ? [r.failure] : [])) };
}
