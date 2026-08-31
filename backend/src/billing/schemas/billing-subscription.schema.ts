import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingSubscriptionDocument = BillingSubscription & Document<Types.ObjectId>;

export const BILLING_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

// Org-scoped (bare-string organizationId, same convention as Wallet/
// CreditReservation) — the "layer on top of the existing wallet" record:
// activating or renewing one of these is nothing more than a
// WalletService.applyLedgerEntry('SUBSCRIPTION_GRANT', ...) call (see
// billing-subscriptions.service.ts/subscription-renewal.service.ts); no
// separate money/credit ledger exists here.
//
// planPriceId is the exact BillingPlanPrice row locked in at subscribe (or
// last-renewal) time — BillingPlanPrice rows are themselves immutable/
// versioned (a price change inserts a new row rather than mutating this
// one), so re-reading this same id always resolves the exact amount/credits
// this subscription is actually paying, even after the plan's "current"
// price has since changed.
@Schema({ timestamps: true, collection: 'billing_subscriptions' })
export class BillingSubscription {
  // No `index: true` here — the explicit unique partial index below already
  // covers every organizationId lookup this module makes (always combined
  // with a status filter); a second plain index on the same key would just
  // duplicate it (Mongoose warns on exactly this at boot).
  @Prop({ required: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  planId: string;

  @Prop({ required: true })
  planPriceId: string;

  @Prop({ required: true, enum: BILLING_SUBSCRIPTION_STATUSES, index: true })
  status: BillingSubscriptionStatus;

  @Prop({ required: true })
  currentPeriodStart: Date;

  @Prop({ required: true, index: true })
  currentPeriodEnd: Date;

  // true once cancel() has been called — the subscription keeps its
  // existing entitlement through currentPeriodEnd; subscription-renewal.service.ts
  // sees this flag at the next renewal check and stops the cycle
  // (status -> 'canceled') instead of attempting a charge.
  @Prop({ default: false })
  cancelAtPeriodEnd: boolean;

  // Set on every successful checkout/renewal charge — the PaymentRecord
  // that most recently kept this subscription current.
  @Prop()
  lastRenewalPaymentRecordId?: string;

  // Consecutive failed renewal attempts (no payment method, gateway
  // decline, ...) — subscription-renewal.service.ts increments this on
  // failure and resets it to 0 on success; past
  // config.billing.subscriptionRenewalGraceAttempts the subscription is
  // marked 'expired' instead of retried forever.
  @Prop({ default: 0 })
  renewalFailureCount: number;

  // userId who initiated the subscribe — 'system' for a renewal-driven
  // reactivation, matching WalletTransaction.createdBy's vocabulary.
  @Prop({ required: true })
  createdBy: string;

  // Set only if a coupon was applied at the ORIGINAL signup checkout — a
  // coupon discounts/bonuses that first payment only; subscription-renewal.service.ts
  // never re-applies it, so this is purely a reference for display/reporting
  // ("this subscription started with WELCOME20"), not something renewal logic reads.
  @Prop()
  couponId?: string;
}

export const BillingSubscriptionSchema = SchemaFactory.createForClass(BillingSubscription);
// One LIVE subscription per org — trialing/active/past_due are all "this is
// the org's current subscription" states (a past_due subscription is still
// the current one, just failing renewal, not a historical record);
// canceled/expired are terminal and can freely coexist with a later new
// subscription for the same org, so they're excluded from the partial filter.
BillingSubscriptionSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['trialing', 'active', 'past_due'] } } },
);
BillingSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
