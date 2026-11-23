import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { firstValueFrom } from 'rxjs';
import { ChatGateway } from '../chat/chat.gateway';
import { PaymentEvents } from '../common/payments/payment-events';
import { emailKey, phoneKey } from '../customer-intelligence/customer-matching';
import { extractSquarePaymentDetails, SquareInvoiceRef } from './square-payment-details';
import { SquarePaymentTransaction, SquarePaymentTransactionDocument, SquareTransactionStatus } from './schemas/square-payment-transaction.schema';
import { Model } from 'mongoose';

const SQUARE_API_VERSION = '2026-09-16';

interface SquareMoney {
  amount?: number;
  currency?: string;
}

// Only the fields this service actually reads — confirmed live against
// Square's own Payment object reference (never assumed): status is one of
// exactly 5 real values (APPROVED/PENDING/COMPLETED/CANCELED/FAILED) —
// there is no "PROCESSING" or "DISPUTED" payment status in Square's API at
// all. A completed payment that's been refunded stays COMPLETED and gains
// `refunded_money` — Square tracks the refund's own lifecycle on a
// separate PaymentRefund object, not as a Payment status value.
export interface SquarePaymentLike {
  id: string;
  status?: string;
  customer_id?: string;
  order_id?: string;
  reference_id?: string;
  amount_money?: SquareMoney;
  refunded_money?: SquareMoney;
  source_type?: string;
  location_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** Maps Square's real 5-value Payment.status (+ refunded_money) onto the
 * richer status taxonomy the Gateway Payments feature uses. 'processing'
 * and 'disputed' are deliberately never produced here — confirmed live
 * that Square's Payments API has no such payment status; a dispute is a
 * wholly separate resource (the Disputes API), out of this phase's scope,
 * never faked by guessing at a payment status. */
export function mapSquarePaymentStatus(payment: SquarePaymentLike): SquareTransactionStatus {
  const status = (payment.status ?? '').toUpperCase();
  const total = payment.amount_money?.amount ?? 0;
  const refunded = payment.refunded_money?.amount ?? 0;
  if (status === 'COMPLETED') {
    if (refunded <= 0) return 'completed';
    return refunded >= total ? 'refunded' : 'partially_refunded';
  }
  if (status === 'APPROVED') return 'authorized';
  if (status === 'PENDING') return 'pending';
  if (status === 'CANCELED') return 'cancelled';
  if (status === 'FAILED') return 'failed';
  return 'pending';
}

@Injectable()
export class SquarePaymentMatchingService {
  private readonly logger = new Logger(SquarePaymentMatchingService.name);

  constructor(
    @InjectModel(SquarePaymentTransaction.name) private transactionModel: Model<SquarePaymentTransactionDocument>,
    private http: HttpService,
    private chatGateway: ChatGateway,
    // Tells the payment reconciliation a quote's payments may have changed (webhook, reconciliation or refund).
    @Optional() private paymentEvents?: PaymentEvents,
  ) {}

  private apiBaseUrl(environment: 'sandbox' | 'production'): string {
    return environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  }

  /** Square's own Customer record for this payment's customer_id (never
   * guessed, never matched by name) — email/phone only, the two fields
   * customer-matching.ts's emailKey/phoneKey need. Checks this org's OWN
   * already-resolved transactions for the SAME providerCustomerId first —
   * Square's Customer record for a given id doesn't change payment to
   * payment, so a previously-resolved mapping is reused instead of hitting
   * Square's Customers API again on every single payment from a repeat
   * customer (a real, needless-call gap the approved plan calls out).
   * Falls through to a fresh lookup when nothing's been resolved yet, or
   * when the only prior rows are themselves unmatched (nothing to reuse).
   * Returns {} (never throws) on any failure — a customer lookup failing
   * must never block storing the payment itself; it just stays unmatched,
   * exactly like a payment with no customer_id at all. */
  private async resolveIdentityKeys(organizationId: string, accessToken: string, environment: 'sandbox' | 'production', customerId: string): Promise<{ emailKey?: string; phoneKey?: string }> {
    // $type: 'string' rather than $exists — a prior unresolved attempt may
    // still have written the key with an undefined/null value depending on
    // the driver, which must never read as "already resolved."
    const reused = await this.transactionModel
      .findOne({ organizationId, provider: 'square', providerCustomerId: customerId, $or: [{ matchedEmailKey: { $type: 'string' } }, { matchedPhoneKey: { $type: 'string' } }] })
      .sort({ lastSyncedAt: -1 })
      .select({ matchedEmailKey: 1, matchedPhoneKey: 1 })
      .lean();
    if (reused) return { emailKey: reused.matchedEmailKey, phoneKey: reused.matchedPhoneKey };
    try {
      const { data } = await firstValueFrom(
        this.http.get<{ customer?: { email_address?: string; phone_number?: string } }>(`${this.apiBaseUrl(environment)}/v2/customers/${encodeURIComponent(customerId)}`, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_API_VERSION },
        }),
      );
      const email = emailKey(data.customer?.email_address);
      const phone = phoneKey(data.customer?.phone_number);
      return { emailKey: email || undefined, phoneKey: phone || undefined };
    } catch (err) {
      this.logger.warn(`Could not resolve Square customer ${customerId} for identity matching: ${(err as Error).message}`);
      return {};
    }
  }

  /** The Square Invoice that billed this payment's order. Square Invoices payments carry NO reference_id or note —
   * the only identifier is the invoice itself (its number/title, e.g. "4546 - Surry Hills"), tied to the payment by
   * order_id, an exact id match (never an amount). Reuses what this org already stored for the same order first
   * (partial payments on one invoice share an order), then asks Square once. Never throws: a failed lookup just
   * leaves the payment without an invoice reference, exactly as before. */
  private async resolveInvoice(organizationId: string, accessToken: string, environment: 'sandbox' | 'production', payment: SquarePaymentLike): Promise<SquareInvoiceRef | undefined> {
    if (!payment.order_id || payment.reference_id) return undefined;
    try {
      // A failed stored-row lookup only skips the shortcut; the Square lookup below still runs.
      const known = await Promise.resolve()
        .then(() =>
          this.transactionModel
            .findOne({ organizationId, provider: 'square', orderReference: payment.order_id, 'details.squareInvoiceNumber': { $type: 'string' } })
            .select({ details: 1 })
            .lean(),
        )
        .catch(() => null);
      const d = known?.details as { squareInvoiceId?: string; squareInvoiceNumber?: string; squareInvoiceTitle?: string } | undefined;
      if (d?.squareInvoiceNumber) return { id: d.squareInvoiceId, number: d.squareInvoiceNumber, title: d.squareInvoiceTitle };
      if (!payment.location_id || !payment.customer_id) return undefined;
      const { data } = await firstValueFrom(
        this.http.post<{ invoices?: { id?: string; order_id?: string; invoice_number?: string; title?: string }[] }>(
          `${this.apiBaseUrl(environment)}/v2/invoices/search`,
          { query: { filter: { location_ids: [payment.location_id], customer_ids: [payment.customer_id] } } },
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_API_VERSION } },
        ),
      );
      const invoice = (data.invoices ?? []).find((i) => i.order_id === payment.order_id);
      return invoice ? { id: invoice.id, number: invoice.invoice_number, title: invoice.title } : undefined;
    } catch (err) {
      this.logger.warn(`Could not resolve Square invoice for order ${payment.order_id}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Upserts one Square payment into square_payment_transactions —
   * idempotent on {organizationId, provider, providerPaymentId}, so a
   * webhook redelivery or a reconciliation re-read of the same payment
   * always lands on the SAME row, never a duplicate (the spec's own
   * explicit requirement). Always recomputes every field fresh from the
   * given payment — never merges/increments — so the row is always exactly
   * what Square itself last reported. */
  async upsertFromPayment(
    organizationId: string,
    accessToken: string,
    environment: 'sandbox' | 'production',
    payment: SquarePaymentLike,
    sourceEventId?: string,
    /** Optional pre-read invoices of this org by order id (a historical reconciliation reads them once). */
    invoicesByOrder?: Map<string, SquareInvoiceRef>,
  ): Promise<void> {
    const identity = payment.customer_id ? await this.resolveIdentityKeys(organizationId, accessToken, environment, payment.customer_id) : {};
    // With the org's invoices already read in full, a miss means "no invoice bills this order" — no per-payment search needed.
    const invoice = invoicesByOrder
      ? payment.order_id && !payment.reference_id
        ? invoicesByOrder.get(payment.order_id)
        : undefined
      : await this.resolveInvoice(organizationId, accessToken, environment, payment);
    await this.transactionModel.updateOne(
      { organizationId, provider: 'square', providerPaymentId: payment.id },
      {
        $set: {
          organizationId,
          provider: 'square',
          providerPaymentId: payment.id,
          providerCustomerId: payment.customer_id,
          matchedEmailKey: identity.emailKey,
          matchedPhoneKey: identity.phoneKey,
          transactionReference: payment.reference_id,
          amount: payment.amount_money?.amount ?? 0,
          currency: payment.amount_money?.currency ?? 'USD',
          paymentStatus: mapSquarePaymentStatus(payment),
          paymentMethodType: payment.source_type,
          paymentDate: payment.created_at ? new Date(payment.created_at) : new Date(),
          refundedAmount: payment.refunded_money?.amount ?? 0,
          orderReference: payment.order_id,
          details: extractSquarePaymentDetails(payment, invoice),
          sourceEventId,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );
    this.paymentEvents?.notify(organizationId, (payment.refunded_money?.amount ?? 0) > 0 ? 'refund' : 'gateway-payment');
    // Live push only — the row above is already saved, so a socket problem
    // must never fail (or retry) the webhook/reconciliation that got us
    // here. The Customers page refetches from REST on this signal; REST
    // stays the source of truth for anyone not connected right now.
    try {
      this.chatGateway.emitToOrg(organizationId, 'gateway-payment-updated', { provider: 'square', paymentId: payment.id });
    } catch (err) {
      this.logger.warn(`Live push for Square payment ${payment.id} failed: ${(err as Error).message}`);
    }
  }
}
