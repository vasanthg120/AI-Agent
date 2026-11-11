import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProviderPaymentDocument = ProviderPayment & Document<Types.ObjectId>;

// One row per admin-recorded payment/recharge to an LLM provider — platform
// expenditure, never a customer-facing record (see WalletTransaction for
// that side). A manual ledger, not synced from a provider billing API today
// (none of Anthropic/Groq's APIs expose payment history either — see
// provider-account.schema.ts's own audit comment) — "Where supported,
// synchronize invoices... from provider billing APIs" (spec section 4) has
// nothing to attach to yet for either real provider; this stays
// admin-entered until one does.
@Schema({ collection: 'provider_payments', timestamps: true })
export class ProviderPayment {
  @Prop({ required: true, index: true })
  provider: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, default: 'USD' })
  currency: string;

  @Prop({ required: true, index: true })
  paymentDate: Date;

  @Prop({ required: true })
  paymentMethod: string;

  // Indexed (sparse via the compound index below) — the field a duplicate-
  // payment check keys on when the admin supplies one.
  @Prop()
  transactionId?: string;

  @Prop()
  invoiceNumber?: string;

  // The provider-side credit this payment is expected to grant — distinct
  // from `amount` (what Haive paid) since tax/fees above reduce the credit
  // actually usable without changing what was charged.
  @Prop()
  creditPurchased?: number;

  @Prop()
  taxAmount?: number;

  @Prop()
  feeAmount?: number;

  // GridFS id/filename/mimeType — same three-field-on-the-parent-document
  // convention customer-jobs.service.ts's own referenceFileId/Name/MimeType
  // already uses for an attached file.
  @Prop()
  receiptFileId?: string;

  @Prop()
  receiptFileName?: string;

  @Prop()
  receiptFileMimeType?: string;

  @Prop({ enum: ['recorded', 'confirmed', 'disputed'], default: 'recorded' })
  status: 'recorded' | 'confirmed' | 'disputed';

  @Prop({ required: true })
  recordedByAdminId: string;

  @Prop()
  notes?: string;
}

export const ProviderPaymentSchema = SchemaFactory.createForClass(ProviderPayment);
ProviderPaymentSchema.index({ provider: 1, paymentDate: -1 });
// A plain `sparse: true` compound index does NOT skip a document just
// because transactionId is missing — Mongo's sparse rule for a COMPOUND
// index only excludes a document when EVERY indexed field is absent, and
// `provider` is always present here. Confirmed live: two payments for the
// same provider with no transactionId collided as duplicate
// { provider, null } keys under plain sparse. A partial index with an
// explicit filter is the correct way to say "only unique when
// transactionId actually exists" — most admin-entered payments have none,
// and those must never collide with each other.
ProviderPaymentSchema.index({ provider: 1, transactionId: 1 }, { unique: true, partialFilterExpression: { transactionId: { $exists: true } } });
