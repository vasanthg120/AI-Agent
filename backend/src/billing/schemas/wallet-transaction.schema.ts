import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WalletTransactionDocument = WalletTransaction & Document<Types.ObjectId>;

export const WALLET_TRANSACTION_TYPES = [
  'FREE_TRIAL',
  'PURCHASE',
  'AI_USAGE',
  'AUTO_RECHARGE',
  'BONUS',
  'PROMOTION',
  'REFUND',
  'MANUAL_ADJUSTMENT',
  // Credits granted by a BillingSubscription activating or renewing (see
  // billing-subscriptions.service.ts/subscription-renewal.service.ts) —
  // the "layer on top of the existing wallet" hook: a subscription's only
  // effect on Wallet/WalletTransaction is one of these rows per cycle,
  // otherwise indistinguishable from any other credit grant.
  'SUBSCRIPTION_GRANT',
] as const;
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];

// The immutable ledger — the actual source of truth for "what happened to
// this org's credits," independent of Wallet.balanceCredits (which is a
// fast-read cache maintained exclusively via atomic $inc). No service in
// this module ever calls updateOne/deleteOne against this model; every
// balance-affecting operation writes exactly one new row here alongside its
// atomic Wallet update, in the same spirit as a real accounting ledger.
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'wallet_transactions' })
export class WalletTransaction {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  walletId: string;

  @Prop({ required: true, enum: WALLET_TRANSACTION_TYPES, index: true })
  type: WalletTransactionType;

  // Signed: positive credits the wallet, negative debits it.
  @Prop({ required: true })
  amountCredits: number;

  // Snapshot of balanceCredits immediately after this transaction applied —
  // lets an audit replay be verified without re-deriving running totals.
  @Prop({ required: true })
  balanceAfterCredits: number;

  @Prop({ index: true })
  reservationId?: string;

  @Prop()
  paymentRecordId?: string;

  // e.g. {requestId, providerCostUsd, marginPct, executionCount, byProvider,
  // totalInputTokens, totalOutputTokens} for AI_USAGE rows;
  // {provider, gatewayPaymentId, simulated, ...} for PURCHASE/AUTO_RECHARGE.
  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  // userId, or 'system' / 'autopay' / 'platform_admin'.
  @Prop({ required: true })
  createdBy: string;

  @Prop({ index: true })
  createdAt: Date;
}

export const WalletTransactionSchema = SchemaFactory.createForClass(WalletTransaction);
WalletTransactionSchema.index({ organizationId: 1, createdAt: -1 });
WalletTransactionSchema.index({ organizationId: 1, type: 1, createdAt: -1 });
