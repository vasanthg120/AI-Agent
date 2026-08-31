import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CouponRedemptionDocument = CouponRedemption & Document<Types.ObjectId>;

// One row per successful (payment-confirmed, not merely attempted) coupon
// use — this collection IS the source of truth CouponsService.validate
// counts against for maxRedemptions/maxRedemptionsPerOrg, so a row is only
// ever written once a purchase/subscription checkout has actually been
// confirmed (see CouponsService.recordRedemption's callers), never at the
// point a coupon code is merely typed in.
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'billing_coupon_redemptions' })
export class CouponRedemption {
  @Prop({ required: true, index: true })
  couponId: string;

  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  redeemedBy: string;

  @Prop({ required: true, enum: ['subscription_checkout', 'credit_purchase'] })
  context: 'subscription_checkout' | 'credit_purchase';

  @Prop()
  subscriptionId?: string;

  @Prop({ required: true, unique: true })
  paymentRecordId: string;

  @Prop({ default: 0 })
  amountDiscounted: number;

  @Prop({ default: 0 })
  bonusCredits: number;

  @Prop({ index: true })
  createdAt: Date;
}

export const CouponRedemptionSchema = SchemaFactory.createForClass(CouponRedemption);
CouponRedemptionSchema.index({ couponId: 1, organizationId: 1 });
