import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingInvoiceCounterDocument = BillingInvoiceCounter & Document<Types.ObjectId>;

// A SINGLE global sequence (fixed `key: 'global'`), not per-organization —
// deliberately different from royalty/schemas/invoice-counter.schema.ts's
// per-org counter. Royalty invoices are a client/deal-billing concept scoped
// to each tenant's own numbering; these are Haive's own platform invoices
// issued to its customers, and a real SaaS platform's invoice numbers run
// one continuous sequence across every customer (INV-1001, INV-1002,
// INV-1003, ... regardless of which org each belongs to) — matching how the
// spec's own numbering example reads. Incremented atomically via
// findOneAndUpdate({$inc}), same idiom as the royalty counter.
@Schema({ timestamps: true, collection: 'billing_invoice_counters' })
export class BillingInvoiceCounter {
  @Prop({ required: true, unique: true, default: 'global' })
  key: string;

  @Prop({ default: 0 })
  seq: number;
}

export const BillingInvoiceCounterSchema = SchemaFactory.createForClass(BillingInvoiceCounter);
