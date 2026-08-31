import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PaymentProviderKey } from '../providers/payment-provider.interface';

export type PaymentRecordDocument = PaymentRecord & Document<Types.ObjectId>;

// One row per purchase or AutoPay recharge attempt, against whichever
// gateway was active at the time (see PaymentProviderKey) — a deployment
// that switches ACTIVE_PAYMENT_PROVIDER mid-flight ends up with rows from
// more than one gateway in this same collection, which `provider` disambiguates.
// gatewayOrderId is unique so a retried/duplicated order-creation call can
// never produce two rows for the same order; gatewayPaymentId is
// unique-sparse (absent until a payment actually completes).
@Schema({ timestamps: true, collection: 'payment_records' })
export class PaymentRecord {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  walletId: string;

  // 'subscription_checkout' — the first payment for a new BillingSubscription
  // (see that schema); 'subscription_renewal' — a recurring charge made
  // synchronously by subscription-renewal.service.ts's cron, same
  // charge-the-saved-method shape as 'autopay' but against a subscription's
  // locked-in price instead of a flat recharge amount.
  @Prop({ required: true, enum: ['purchase', 'autopay', 'subscription_checkout', 'subscription_renewal'] })
  type: 'purchase' | 'autopay' | 'subscription_checkout' | 'subscription_renewal';

  @Prop({ required: true, enum: ['razorpay', 'stripe', 'cashfree'], index: true })
  provider: PaymentProviderKey;

  // Absent for 'autopay'/subscription rows — Auto Recharge tops up to a
  // target balance (see wallet.schema.ts's AutoPaySettings) and a
  // subscription grants credits via its BillingPlanPrice, neither is tied
  // to a CreditPackage the way a customer-initiated purchase is.
  @Prop()
  creditPackageId?: string;

  // Only set for 'subscription_checkout'/'subscription_renewal' rows —
  // subscriptionPlanId/subscriptionPriceId carry the checkout INTENT
  // (before a BillingSubscription exists yet, same reason creditPackageId
  // captures intent for a purchase); subscriptionId is filled in once
  // activation actually creates/updates the subscription document, for
  // traceability from either side.
  @Prop()
  subscriptionPlanId?: string;

  @Prop()
  subscriptionPriceId?: string;

  @Prop()
  subscriptionId?: string;

  // Set only when a coupon was applied at checkout — the discount/bonus
  // actually granted is locked in here at PaymentRecord-creation time (same
  // convention as `amount`/`creditsGranted` themselves already being
  // locked in, not re-derived later), and CouponsService.recordRedemption
  // writes a CouponRedemption row from these exact values once the payment
  // is confirmed. `amount`/`creditsGranted` above already reflect the
  // coupon's effect (discounted price and/or bonus credits included).
  @Prop()
  couponId?: string;

  @Prop()
  couponDiscountAmount?: number;

  @Prop()
  couponBonusCredits?: number;

  @Prop({ required: true, unique: true })
  gatewayOrderId: string;

  @Prop({ unique: true, sparse: true })
  gatewayPaymentId?: string;

  @Prop()
  gatewaySignature?: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  creditsGranted: number;

  @Prop({
    required: true,
    enum: ['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'],
    default: 'created',
    index: true,
  })
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';

  // True when this payment never touched the real gateway API — the
  // adapter simulated success because that gateway's keys aren't
  // configured yet. Kept visible (not hidden) so the admin console can
  // distinguish real revenue from dev-mode simulated activity.
  @Prop({ default: false })
  simulated: boolean;

  // Phase 6 — cumulative across every successful Refund row for this
  // payment (see schemas/refund.schema.ts); RefundService is the only
  // writer. status flips to 'refunded' once this reaches `amount`, or
  // 'partially_refunded' while it's between 0 and `amount`.
  @Prop({ default: 0 })
  refundedAmount: number;

  // Cumulative credits already clawed back across every successful refund
  // on this payment — tracked separately from refundedAmount so a SECOND
  // (or later) partial refund can compute exactly how many additional
  // credits it should claw back (target cumulative minus what's already
  // gone), rather than re-deriving from creditsGranted alone and
  // double-counting a prior partial refund's share.
  @Prop({ default: 0 })
  refundedCreditsTotal: number;

  @Prop({ type: Object })
  rawWebhookPayload?: Record<string, unknown>;
}

export const PaymentRecordSchema = SchemaFactory.createForClass(PaymentRecord);
PaymentRecordSchema.index({ organizationId: 1, createdAt: -1 });
PaymentRecordSchema.index({ organizationId: 1, status: 1 });
