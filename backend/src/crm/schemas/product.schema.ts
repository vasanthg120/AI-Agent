import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductDocument = Product & Document<Types.ObjectId>;

// Minimal product/service master for Quote line items — deliberately no
// inventory, warehouse, vendor, or price-list concepts (see
// crm.service.ts's own pre-existing listProducts() stub comment: "no native
// product catalog yet"). This is that catalog, finally given real data, but
// scoped to exactly what a quote line item needs: a name, an optional SKU,
// and a unit price. A "service" is just a Product with no physical stock
// concept attached — no separate schema, since nothing here assumes physical
// goods.
@Schema({ timestamps: true, collection: 'crm_products' })
export class Product {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  sku?: string;

  @Prop()
  description?: string;

  @Prop({ required: true, default: 0 })
  unitPrice: number;

  // Matches the native-Quote currency convention (see quotes.service.ts's
  // createDraftQuote, which already writes 'INR') rather than the Quote
  // schema's own historical 'USD' default — see quote.schema.ts's
  // currency field comment for why those two differ.
  @Prop({ default: 'INR' })
  currency: string;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop()
  createdBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ organizationId: 1, name: 1 });
// Same partialFilterExpression idiom as quote.schema.ts/deal.schema.ts —
// never bare `sparse` for a compound unique index (see those files' own
// comments for the real production bug that convention avoids). Two
// products in the same org with no sku must both be allowed; two with the
// same sku must not.
ProductSchema.index(
  { organizationId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $exists: true } } },
);
