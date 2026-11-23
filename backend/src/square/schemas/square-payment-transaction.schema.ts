import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SquarePaymentTransactionDocument = SquarePaymentTransaction & Document<Types.ObjectId>;

export type SquareTransactionStatus =
  | 'pending'
  | 'processing'
  | 'authorized'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed';

// One Haive-side record per Square payment, centralizing it against a
// customer the way the spec asks for. Deliberately named "square_payment_
// transactions" (not "payments") and surfaced in the UI as "Gateway
// Payments" — the Customers page already has an unrelated `payment` concept
// (quote-receivables status: billed/outstanding, see
// customer-directory.service.ts's own `payment`/`payment_pending` view
// filters), and this must never collide with or silently change that.
//
// Never a customerId foreign key: `/customers` has no stable per-customer
// id at all (customer-directory.service.ts clusters contacts/deals/quotes
// by email/phone into a SYNTHETIC id computed fresh on every read — see its
// own comment). matchedEmailKey/matchedPhoneKey below are the same
// normalized keys customer-matching.ts computes, resolved once at ingest
// time; customer-directory.service.ts joins against these keys the exact
// same way it already joins mail, never via a second matching algorithm.
@Schema({ timestamps: true, collection: 'square_payment_transactions' })
export class SquarePaymentTransaction {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, default: 'square' })
  provider: 'square';

  @Prop({ required: true })
  providerPaymentId: string;

  @Prop()
  providerCustomerId?: string;

  // Resolved once at webhook-ingest time (see square-payment-matching.
  // service.ts) from Square's own Customer record for this payment — never
  // guessed, never matched by name. Absent means Square gave no email/
  // phone for this payment's customer, or there is no customer_id on the
  // payment at all (e.g. a walk-up card payment with no customer profile);
  // the transaction is still stored (never silently discarded, per the
  // spec), just unmatched to any Haive customer — see
  // customer-directory.service.ts's own handling of an empty key.
  @Prop()
  matchedEmailKey?: string;

  @Prop()
  matchedPhoneKey?: string;

  @Prop()
  transactionReference?: string;

  // Minor units (cents) — same convention Square's own API uses, kept
  // as-is rather than converted, so every amount in this collection always
  // means exactly what Square itself reported, with zero rounding risk.
  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true, enum: ['pending', 'processing', 'authorized', 'completed', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'disputed'] })
  paymentStatus: SquareTransactionStatus;

  @Prop()
  paymentMethodType?: string;

  @Prop({ required: true })
  paymentDate: Date;

  // Always the full picture as of the last sync — never incremented, so a
  // duplicate webhook delivery or a reconciliation re-read can never double
  // -count a refund (same "recompute from source, don't add to a running
  // total" rule customer-directory.service.ts's own payment-summary
  // computation follows for quote payments already).
  @Prop({ default: 0 })
  refundedAmount: number;

  @Prop()
  orderReference?: string;

  // The webhook delivery (or reconciliation pass) that produced/last
  // confirmed this row — traceability back to why this row has the values
  // it has, not itself a dedup key (that's the compound index below).
  @Prop()
  sourceEventId?: string;

  // Sanitized allowlist of Square's Payment object (see square-payment-
  // details.ts) — card brand/last4, fees, receipt URL, references, etc. Never
  // fingerprint/BIN/CVV/auth codes. Optional: rows synced before this existed
  // simply lack it and are filled in on the next webhook/reconciliation.
  @Prop({ type: Object })
  details?: Record<string, unknown>;

  // When the reconciliation last looked for the Square Invoice that billed this payment's order (see
  // payment-reconciliation.service.ts) — so a payment with no invoice is not re-read on every run.
  @Prop()
  invoiceCheckedAt?: Date;

  @Prop({ required: true })
  lastSyncedAt: Date;
}

export const SquarePaymentTransactionSchema = SchemaFactory.createForClass(SquarePaymentTransaction);
// The exact "never double-write the same payment" guard the spec's own
// Phase 4 asks for — whether written by a webhook, a reconciliation pass,
// or (hypothetically) both for the same payment, only one row ever exists.
SquarePaymentTransactionSchema.index({ organizationId: 1, provider: 1, providerPaymentId: 1 }, { unique: true });
// The directory's own per-request lookup shape: "every transaction this org
// has for these identity keys."
SquarePaymentTransactionSchema.index({ organizationId: 1, matchedEmailKey: 1 });
SquarePaymentTransactionSchema.index({ organizationId: 1, matchedPhoneKey: 1 });
