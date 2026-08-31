import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingInvoiceDocument = BillingInvoice & Document<Types.ObjectId>;

// Mirrors PaymentRecord.type exactly (see schemas/payment-record.schema.ts)
// — a BillingInvoice is generated 1:1 from a captured PaymentRecord, so
// reusing its exact type vocabulary avoids a second, easily-drifting enum.
export const BILLING_INVOICE_TYPES = ['purchase', 'autopay', 'subscription_checkout', 'subscription_renewal'] as const;
export type BillingInvoiceType = (typeof BILLING_INVOICE_TYPES)[number];

// Embedded, not a separate collection — an invoice's line items are always
// read/rendered together with the invoice itself and never queried across
// invoices, same reasoning as BillingPlan.features[]/limits[].
@Schema({ _id: false })
export class BillingInvoiceItem {
  @Prop({ required: true })
  description: string;

  @Prop({ required: true, default: 1 })
  quantity: number;

  @Prop({ required: true })
  unitAmount: number;

  @Prop({ required: true })
  amount: number;
}
const BillingInvoiceItemSchema = SchemaFactory.createForClass(BillingInvoiceItem);

// Frozen company identity at the moment an invoice was issued — deliberately
// copied rather than read live from BillingSettings at render time, so a
// later change to the company's address/logo/tax id never rewrites the
// content of an invoice that already went out. Same "snapshot, don't
// re-derive" philosophy as BillingSubscription.planPriceId locking in an
// exact price.
@Schema({ _id: false })
export class BillingInvoiceCompanySnapshot {
  @Prop({ required: true })
  companyName: string;

  @Prop()
  companyLogoUrl?: string;

  @Prop()
  companyAddress?: string;

  @Prop()
  companyEmail?: string;

  @Prop()
  companyTaxId?: string;

  @Prop()
  footerText?: string;

  @Prop()
  termsText?: string;
}
const BillingInvoiceCompanySnapshotSchema = SchemaFactory.createForClass(BillingInvoiceCompanySnapshot);

// Deliberately named/collectioned `BillingInvoice`/`billing_invoices`, NOT
// `Invoice`/`invoices` — RoyaltyModule already owns that name for a
// completely different domain (client/deal invoicing). One row per
// CAPTURED payment only (see billing-invoice.service.ts) — a failed or
// still-pending checkout never gets an invoice, matching how a real
// receipt/invoice is only ever issued for money actually collected.
@Schema({ timestamps: true, collection: 'billing_invoices' })
export class BillingInvoice {
  @Prop({ required: true, index: true })
  organizationId: string;

  // "INV-1001" etc, from the single global BillingInvoiceCounter sequence.
  @Prop({ required: true, unique: true, index: true })
  invoiceNumber: string;

  @Prop({ required: true, enum: BILLING_INVOICE_TYPES })
  type: BillingInvoiceType;

  // One invoice per PaymentRecord — the unique index is also this schema's
  // idempotency guard (see BillingInvoiceService.generateForPaymentRecord).
  @Prop({ required: true, unique: true })
  paymentRecordId: string;

  @Prop()
  subscriptionId?: string;

  @Prop({ required: true, enum: ['paid', 'void'], default: 'paid', index: true })
  status: 'paid' | 'void';

  @Prop({ required: true })
  currencyCode: string;

  @Prop({ required: true })
  subtotal: number;

  @Prop({ default: 0 })
  discountAmount: number;

  @Prop()
  couponId?: string;

  @Prop({ default: 0 })
  taxAmount: number;

  @Prop()
  taxRateId?: string;

  @Prop({ required: true })
  total: number;

  @Prop({ type: [BillingInvoiceItemSchema], default: [] })
  items: BillingInvoiceItem[];

  @Prop({ type: BillingInvoiceCompanySnapshotSchema, required: true })
  billingSnapshot: BillingInvoiceCompanySnapshot;

  @Prop({ required: true })
  issuedAt: Date;

  @Prop()
  paidAt?: Date;

  @Prop()
  voidedAt?: Date;

  @Prop()
  voidReason?: string;
}

export const BillingInvoiceSchema = SchemaFactory.createForClass(BillingInvoice);
BillingInvoiceSchema.index({ organizationId: 1, issuedAt: -1 });
