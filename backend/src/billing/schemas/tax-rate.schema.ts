import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TaxRateDocument = TaxRate & Document<Types.ObjectId>;

// Platform-global catalog (no organizationId — same precedent as Currency/
// BillingPlan). Nothing reads this yet (a future checkout/invoice flow is
// the intended consumer, per the billing extension plan) — Phase 1 is the
// admin CRUD surface only, so an admin can start configuring GST/VAT/sales
// tax rows ahead of anything actually applying them.
@Schema({ timestamps: true, collection: 'billing_tax_rates' })
export class TaxRate {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  // e.g. 18 for 18% GST — a plain percentage, not a fraction, matching how
  // an admin would type it in and how it reads back in a UI label.
  @Prop({ required: true })
  percentage: number;

  // ISO 3166-1 alpha-2 (e.g. 'IN', 'US'), uppercased on write. Absent means
  // "applies regardless of country" — same optional-means-unscoped
  // convention as User.storeId.
  @Prop({ uppercase: true, index: true })
  countryCode?: string;

  // Freeform sub-country region (e.g. a US state) — no fixed vocabulary,
  // same reasoning as CreditPackage/TaxRate.key not being enum-constrained.
  @Prop()
  region?: string;

  // Whether a price this tax applies to is understood to already include
  // the tax (true) or the tax is added on top at checkout (false, the more
  // common default for a GST/VAT line item shown separately).
  @Prop({ default: false })
  inclusive: boolean;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const TaxRateSchema = SchemaFactory.createForClass(TaxRate);
