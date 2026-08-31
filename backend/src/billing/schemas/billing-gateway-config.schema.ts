import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PaymentProviderKey } from '../providers/payment-provider.interface';

export type BillingGatewayConfigDocument = BillingGatewayConfig & Document<Types.ObjectId>;

// Phase 8 (optional) — one row per (provider, mode) pair, e.g. a org could
// have both a 'test' and a 'live' Razorpay row on file simultaneously (only
// the one matching config.billing.paymentMode is ever read). Additive
// alongside today's env-var configuration, NOT a replacement: each payment
// provider's constructor keeps doing its existing synchronous env-var setup
// unchanged (zero risk to that code path), and only OVERRIDES it from here
// in its OnModuleInit hook if an active row exists for its own
// (provider, mode) — see razorpay-payment.provider.ts's onModuleInit for
// the exact precedent. An admin-saved credential change takes effect on the
// next app restart, not hot-reloaded into an already-running gateway client
// — deliberately, to avoid mutating a live payment SDK client mid-request,
// the one piece of this whole extension actually touching real money
// movement while the process is up.
@Schema({ timestamps: true, collection: 'billing_gateway_configs' })
export class BillingGatewayConfig {
  @Prop({ required: true, enum: ['razorpay', 'stripe', 'cashfree'] })
  provider: PaymentProviderKey;

  @Prop({ required: true, enum: ['live', 'test'] })
  mode: 'live' | 'test';

  // Each value individually run through EncryptionService.encrypt() before
  // save — same pattern as PaymentMethod.gatewayTokenIdEncrypted, applied
  // at the service layer, never a schema hook. Keys are provider-specific:
  // razorpay -> {keyId, keySecret, webhookSecret}; stripe ->
  // {secretKey, publishableKey, webhookSecret}; cashfree ->
  // {clientId, clientSecret, webhookSecret}.
  @Prop({ type: Object, default: {} })
  credentialsEncrypted: Record<string, string>;

  @Prop({ default: true, index: true })
  isActive: boolean;
}

export const BillingGatewayConfigSchema = SchemaFactory.createForClass(BillingGatewayConfig);
BillingGatewayConfigSchema.index({ provider: 1, mode: 1 }, { unique: true });
