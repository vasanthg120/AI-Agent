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

  // Hoops-parity Catalog (vendor/image/sizes/colors, Pre-Built Items) — all
  // additive/optional so every pre-existing Product (and every Quote line
  // item referencing one by _id/name/currency only, see quotes.service.ts)
  // is untouched. Vendor is a soft reference (validated org-scoped at the
  // DTO layer, same convention as Deal.leadSource) rather than a Mongoose
  // ref — Vendor lives in a separate top-level module (VendorsModule) and
  // this schema has no reason to couple to its document shape.
  @Prop({ index: true })
  vendorId?: string;

  // GridFS file id (catalog_product_images bucket) — null until an image is
  // uploaded via POST crm/products/:id/image. Only one image per product,
  // matching Hoops' "Primary Image" field exactly (its own form note: "You
  // can only select one image for the Product's primary image").
  @Prop()
  imageFileId?: string;

  @Prop()
  imageMimeType?: string;

  @Prop({ type: [String], default: [] })
  sizes: string[];

  @Prop({ type: [String], default: [] })
  colors: string[];

  // A Pre-Built Item is the same underlying record as a Product — Hoops'
  // own Pre-Built Items tab shows the identical card UI (image, name, "..."
  // menu), just without the vendor/code facts a sourced Product carries,
  // and its own "ADD PRE-BUILT ITEMS" flow never demonstrates a vendor/code
  // field being required. Modeled as a discriminator rather than a second
  // schema+collection: a prebuilt item is a Product that skips the
  // vendor/code requirement, nothing else about it is a different kind of
  // entity, and Quote line items reference both kinds identically.
  @Prop({ enum: ['product', 'prebuilt'], default: 'product', index: true })
  kind: 'product' | 'prebuilt';

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
ProductSchema.index({ organizationId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $exists: true } } });
