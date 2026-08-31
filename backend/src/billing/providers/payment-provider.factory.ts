import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { BillingSettingsDocument } from '../schemas/billing-settings.schema';
import { CashfreePaymentProvider } from './cashfree-payment.provider';
import { PaymentProviderAdapter } from './payment-provider.interface';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

/** Selects which concrete adapter is bound to the PAYMENT_PROVIDER token.
 * `BillingSettings.defaultPaymentProvider` (Admin-haive's Payment Settings
 * page) is checked first; `config.billing.activePaymentProvider` (the
 * env var, today's only source) is the fallback when an admin hasn't set
 * one — additive, so a deployment that's never touched the admin UI
 * behaves exactly as before. Async because the admin override needs a real
 * DB read; this only ever runs once at boot (same restart-to-apply
 * boundary as BillingGatewayConfig credentials in each provider's own
 * onModuleInit). All three concrete providers are still registered as
 * ordinary Nest providers (see billing.module.ts) and fully constructed
 * regardless of which is active — each is independently either
 * "configured" (real keys present) or "simulated" (see each provider's own
 * constructor warning), so their webhook routes stay reachable and
 * functional even for a non-active provider (useful mid-migration between
 * gateways). */
export async function paymentProviderFactory(
  config: ConfigService,
  razorpay: RazorpayPaymentProvider,
  stripe: StripePaymentProvider,
  cashfree: CashfreePaymentProvider,
  settingsModel: Model<BillingSettingsDocument>,
): Promise<PaymentProviderAdapter> {
  const settings = await settingsModel.findOne({ singletonKey: 'default' }).exec();
  const active = settings?.defaultPaymentProvider || config.get<string>('billing.activePaymentProvider') || 'razorpay';
  switch (active) {
    case 'stripe':
      return stripe;
    case 'cashfree':
      return cashfree;
    default:
      return razorpay;
  }
}
