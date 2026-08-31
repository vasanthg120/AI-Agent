import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BillingSettingsDocument = BillingSettings & Document<Types.ObjectId>;

// Singleton — exactly one document ever exists (the Haive platform's own
// billing/company identity, not a per-organization setting). `singletonKey`
// is fixed to 'default' and uniquely indexed purely to make that guarantee
// enforceable at the database level via findOneAndUpdate({singletonKey:
// 'default'}, ..., {upsert:true}) — see billing-admin-settings.service.ts.
@Schema({ timestamps: true, collection: 'billing_settings' })
export class BillingSettings {
  @Prop({ required: true, unique: true, default: 'default' })
  singletonKey: string;

  @Prop({ default: 'Haive' })
  companyName: string;

  @Prop()
  companyLogoUrl?: string;

  @Prop()
  companyAddress?: string;

  @Prop()
  companyEmail?: string;

  @Prop()
  companyPhone?: string;

  @Prop()
  companyWebsite?: string;

  // GST/VAT/tax registration number, shown on generated invoices when set.
  @Prop()
  companyTaxId?: string;

  @Prop({ default: 'INV' })
  invoiceNumberPrefix: string;

  // First invoice is `${prefix}-${invoiceNumberStart + 1}` (matches the
  // spec's own example: start 1000 -> INV-1001, INV-1002, ...) — see
  // BillingInvoiceService.nextInvoiceNumber.
  @Prop({ default: 1000 })
  invoiceNumberStart: number;

  @Prop()
  invoiceFooterText?: string;

  @Prop()
  invoiceTermsText?: string;

  // Payment-settings additions (Admin-haive) — stored/returned only, not yet
  // read by AutoPayService/payment-provider.factory.ts. The active gateway
  // and payment mode are still resolved from config.billing.activePaymentProvider/
  // paymentMode (env vars, optionally overridden per-provider by
  // BillingGatewayConfig — see billing-admin-gateways.controller.ts) exactly
  // as before; wiring these fields into that resolution — or into
  // AutoPayService's recharge-amount validation — is a deliberate, separate
  // follow-up, not bundled here, since that would be an actual behavior
  // change to existing money logic rather than an additive admin setting.
  @Prop()
  defaultPaymentProvider?: string;

  // Admin override of config.billing.paymentMode (env PAYMENT_MODE) — see
  // each provider's onModuleInit for how this is applied (restart-to-apply,
  // same boundary as the gateway-credential override it already has).
  @Prop({ enum: ['live', 'test'] })
  defaultPaymentMode?: 'live' | 'test';

  @Prop({ type: [String], default: undefined })
  enabledGateways?: string[];

  // Display/default-only — which Currency catalog code the admin's Payment
  // Settings page pre-selects. Does not touch PricingService's conversion
  // math (usdToCurrencyRate) or any charge calculation; a plan/package's own
  // currency (set per-price/per-package) is still what's actually charged.
  @Prop()
  defaultCurrencyCode?: string;

  @Prop()
  autoRechargeMinCredits?: number;

  @Prop()
  autoRechargeMaxCredits?: number;

  // Whether a subscription checkout should auto-enable Auto Recharge once
  // the customer's card is saved — see billing-subscriptions flow /
  // SubscriptionCheckoutModal.tsx. Admin escape hatch; the product default
  // (this field unset) is "on".
  @Prop({ default: true })
  autoRechargeDefaultOn: boolean;
}

export const BillingSettingsSchema = SchemaFactory.createForClass(BillingSettings);
