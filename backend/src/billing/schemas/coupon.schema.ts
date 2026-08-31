import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CouponDocument = Coupon & Document<Types.ObjectId>;

export const COUPON_TYPES = ['percentage', 'fixed_amount', 'free_credits'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const COUPON_APPLIES_TO = ['all', 'plans', 'packages'] as const;
export type CouponAppliesTo = (typeof COUPON_APPLIES_TO)[number];

// Platform-global catalog (no organizationId — same precedent as
// CreditPackage/BillingPlan). Applies to either a subscription checkout
// ('plans'), a credit-package purchase ('packages'), or both ('all') — see
// CouponsService.validate for the actual application logic; this schema is
// pure configuration.
@Schema({ timestamps: true, collection: 'billing_coupons' })
export class Coupon {
  @Prop({ required: true, unique: true, uppercase: true })
  code: string;

  @Prop({ required: true, enum: COUPON_TYPES })
  type: CouponType;

  // Meaning depends on `type`: percentage -> 0-100; fixed_amount -> an
  // amount in `currencyCode`; free_credits -> a flat number of bonus
  // credits granted on top of the purchase/plan's own credits, with no
  // price discount at all.
  @Prop({ required: true })
  value: number;

  // Required (and checked against the actual purchase's currency) only for
  // type:'fixed_amount' — a percentage or a bonus-credits count has no
  // currency of its own.
  @Prop()
  currencyCode?: string;

  @Prop()
  description?: string;

  @Prop({ enum: COUPON_APPLIES_TO, default: 'all' })
  appliesTo: CouponAppliesTo;

  // Only meaningful when appliesTo is 'plans' or 'all' — empty/absent means
  // "any plan". Restricting packages by key isn't supported (packages are a
  // much smaller, platform-curated catalog than plans; if that's ever
  // needed, extend this the same way rather than duplicating the field).
  @Prop({ type: [String], default: [] })
  applicablePlanIds: string[];

  @Prop()
  validFrom?: Date;

  @Prop()
  validTo?: Date;

  // Total redemptions across every organization — undefined/null means
  // unlimited.
  @Prop()
  maxRedemptions?: number;

  @Prop({ default: 1 })
  maxRedemptionsPerOrg: number;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);
