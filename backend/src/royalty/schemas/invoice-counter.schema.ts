import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvoiceCounterDocument = InvoiceCounter & Document<Types.ObjectId>;

// One doc per org, incremented atomically via findOneAndUpdate({$inc}) —
// backs InvoicesService's "INV-0001"-style invoiceNumber generation on
// every creation path (manual or auto-drafted from an approved Quote).
// Mirrors crm/schemas/quote-counter.schema.ts exactly.
@Schema({ timestamps: true, collection: 'royalty_invoice_counters' })
export class InvoiceCounter {
  // Indexed by the unique index below only (see quote-counter.schema.ts).
  @Prop({ required: true })
  organizationId: string;

  @Prop({ default: 0 })
  seq: number;
}

export const InvoiceCounterSchema = SchemaFactory.createForClass(InvoiceCounter);
InvoiceCounterSchema.index({ organizationId: 1 }, { unique: true });
