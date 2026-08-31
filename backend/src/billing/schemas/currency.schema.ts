import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CurrencyDocument = Currency & Document<Types.ObjectId>;

// Platform-global catalog (no organizationId — same precedent as
// CreditPackage/ProviderPricing/BillingPlan). DB-backed override of today's
// single config.billing.currency/usdToCurrencyRate env-var pair — see
// PricingService's optional rateOverride parameters for how a specific
// Currency row's rate can be used in place of the platform default, without
// changing what any existing caller (ReservationService, BillingAdminService)
// gets when it doesn't pass one.
@Schema({ timestamps: true, collection: 'billing_currencies' })
export class Currency {
  // ISO 4217, e.g. 'INR'/'USD' — uppercased on write by the admin service,
  // not validated against a fixed ISO list (same freeform-but-conventional
  // approach as CreditPackage.currency/BillingPlanPrice.currencyCode).
  @Prop({ required: true, unique: true, uppercase: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  symbol: string;

  @Prop({ default: 2 })
  decimalDigits: number;

  @Prop({ enum: ['before', 'after'], default: 'before' })
  symbolPosition: 'before' | 'after';

  // 1 USD = this many units of `code` — mirrors config.billing.usdToCurrencyRate's
  // meaning exactly, just DB-backed and per-currency instead of one global value.
  @Prop({ required: true })
  usdToCurrencyRate: number;

  // Exactly one Currency should have this true at a time — enforced in
  // BillingAdminCurrenciesService (unsets every other row), not here; a
  // schema-level uniqueness constraint on a boolean isn't expressible as a
  // simple unique index the way Wallet.organizationId's is.
  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ default: true, index: true })
  active: boolean;
}

export const CurrencySchema = SchemaFactory.createForClass(Currency);
