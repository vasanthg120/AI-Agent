import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingSubscriptionEventDocument = BillingSubscriptionEvent & Document<Types.ObjectId>;

export const BILLING_SUBSCRIPTION_EVENT_TYPES = [
  'created',
  'renewed',
  'renewal_failed',
  'canceled',
  'reactivated',
  'expired',
] as const;
export type BillingSubscriptionEventType = (typeof BILLING_SUBSCRIPTION_EVENT_TYPES)[number];

// Append-only lifecycle log — same immutable-ledger philosophy as
// WalletTransaction, but for subscription state transitions instead of
// money. Never updated/deleted; every BillingSubscription status change
// writes exactly one new row here.
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'billing_subscription_events' })
export class BillingSubscriptionEvent {
  @Prop({ required: true, index: true })
  subscriptionId: string;

  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, enum: BILLING_SUBSCRIPTION_EVENT_TYPES, index: true })
  type: BillingSubscriptionEventType;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  @Prop({ index: true })
  createdAt: Date;
}

export const BillingSubscriptionEventSchema = SchemaFactory.createForClass(BillingSubscriptionEvent);
BillingSubscriptionEventSchema.index({ subscriptionId: 1, createdAt: -1 });
