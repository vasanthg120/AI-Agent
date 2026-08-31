import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingPlanPriceDocument = BillingPlanPrice & Document<Types.ObjectId>;

export const BILLING_CYCLES = ['monthly', 'yearly', 'weekly', 'quarterly', 'one_time'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

// One row per (plan, currency, billing cycle) combination — a plan can have
// several simultaneously-active prices (e.g. Pro/INR/monthly,
// Pro/INR/yearly, Pro/USD/monthly...). Versioned like ProviderPricing
// (effectiveFrom/effectiveTo) so changing a price never rewrites a past
// invoice/subscription's already-locked-in amount — a future
// BillingSubscription is expected to store the exact planPriceId it
// subscribed under, not re-resolve the "current" price live.
@Schema({ timestamps: true, collection: 'billing_plan_prices' })
export class BillingPlanPrice {
  @Prop({ required: true, index: true })
  planId: string;

  @Prop({ required: true, index: true })
  currencyCode: string;

  @Prop({ required: true, enum: BILLING_CYCLES, index: true })
  billingCycle: BillingCycle;

  @Prop({ required: true })
  amount: number;

  // How many Haive Credits subscribing at this price grants per cycle —
  // the layer-on-the-existing-wallet hook: a future subscription
  // activation/renewal calls WalletService.applyLedgerEntry with this
  // number, nothing else.
  @Prop({ required: true })
  creditsGranted: number;

  @Prop({ required: true, index: true })
  effectiveFrom: Date;

  // Same null-means-active convention as ProviderPricing.effectiveTo —
  // explicit `type: Date` for the same emitDecoratorMetadata reason
  // documented there (a `Date | null` union can't be inferred via TS
  // reflection).
  @Prop({ type: Date, default: null, index: true })
  effectiveTo: Date | null;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const BillingPlanPriceSchema = SchemaFactory.createForClass(BillingPlanPrice);
BillingPlanPriceSchema.index({ planId: 1, currencyCode: 1, billingCycle: 1, effectiveFrom: -1 });
