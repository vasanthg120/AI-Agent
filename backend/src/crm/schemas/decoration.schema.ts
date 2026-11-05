import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DecorationDocument = Decoration & Document<Types.ObjectId>;

@Schema({ _id: false })
export class PriceBreak {
  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true, min: 0 })
  price: number;
}
export const PriceBreakSchema = SchemaFactory.createForClass(PriceBreak);

// Hoops-parity Catalog — the decoration price list (screen printing,
// embroidery, etc. applied to a Product/Pre-Built Item), same scoping and
// soft-vendor-reference convention as product.schema.ts. Setup cost is a
// flat one-off fee separate from the per-quantity price breaks, matching
// Hoops' own "Add Decoration" form exactly (Setup Cost field + a
// Quantity/Price row list).
@Schema({ timestamps: true, collection: 'crm_decorations' })
export class Decoration {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ index: true })
  vendorId?: string;

  // Free text, vocabulary enforced at the DTO layer — same convention as
  // Vendor.category (vendor.schema.ts) and Deal.leadSource, rather than a
  // hardcoded enum, since Hoops' own categories (Screen Printing,
  // Embroidery, BYO, ...) are organization/vendor-defined, not fixed.
  @Prop({ required: true })
  category: string;

  @Prop({ required: true, default: 0, min: 0 })
  setupCost: number;

  @Prop({ type: [PriceBreakSchema], default: [] })
  priceBreaks: PriceBreak[];

  @Prop()
  createdBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const DecorationSchema = SchemaFactory.createForClass(Decoration);
DecorationSchema.index({ organizationId: 1, name: 1 });
// Not unique — CSV import upserts by this same (org, name, vendor) triple
// at the application layer (see decorations.service.ts importRows), but two
// vendors are allowed to each have their own decoration of the same name.
DecorationSchema.index({ organizationId: 1, name: 1, vendorId: 1 });
