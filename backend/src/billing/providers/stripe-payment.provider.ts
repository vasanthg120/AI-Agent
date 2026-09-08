import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { BillingGatewayConfig, BillingGatewayConfigDocument } from '../schemas/billing-gateway-config.schema';
import { BillingSettings, BillingSettingsDocument } from '../schemas/billing-settings.schema';
import {
  ChargeResult,
  ConfirmPaymentResult,
  CreateCheckoutOrderResult,
  GenericWebhookEvent,
  PaymentProviderAdapter,
  RefundResult,
  SaveMethodResult,
} from './payment-provider.interface';

/**
 * Structurally complete Stripe integration — a single PaymentIntent flow
 * (setup_future_usage: 'off_session') both charges the initial purchase AND
 * saves the card for later AutoPay off-session charges, no separate
 * SetupIntent round trip needed. Falls back to simulated success when the
 * active mode's secret key isn't configured, same shape as
 * RazorpayPaymentProvider.
 *
 * Frontend note: the existing checkout UI (RazorpayCheckoutModal.tsx) drives
 * Razorpay's Checkout.js widget specifically — Stripe's client-side
 * confirmation (Stripe.js/Elements, using this adapter's returned
 * `clientSecret`) is a separate frontend integration, not built in this
 * pass. This adapter is real and callable via the API/backend today; wiring
 * a Stripe-specific checkout widget is a fast-follow once real Stripe keys
 * make ACTIVE_PAYMENT_PROVIDER=stripe worth using in the UI.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProviderAdapter, OnModuleInit {
  readonly providerKey = 'stripe' as const;
  private readonly logger = new Logger(StripePaymentProvider.name);
  private configured: boolean;
  private client?: Stripe;
  private webhookSecret: string;
  private mode: 'live' | 'test';

  constructor(
    private config: ConfigService,
    private encryption: EncryptionService,
    @InjectModel(BillingGatewayConfig.name) private gatewayConfigModel: Model<BillingGatewayConfigDocument>,
    @InjectModel(BillingSettings.name) private settingsModel: Model<BillingSettingsDocument>,
  ) {
    this.mode = this.config.get<'live' | 'test'>('billing.paymentMode') ?? 'test';
    this.applyEnvKeysForMode();
  }

  /** Shared by the constructor and onModuleInit's admin-mode-override branch
   * below — see RazorpayPaymentProvider.applyEnvKeysForMode's identical
   * rationale. */
  private applyEnvKeysForMode(): void {
    const keys = this.config.get<{ secretKey: string; publishableKey: string; webhookSecret: string }>(`billing.stripe.${this.mode}`);
    const secretKey = keys?.secretKey ?? '';
    this.webhookSecret = keys?.webhookSecret ?? '';
    this.configured = Boolean(secretKey);

    if (!this.configured) {
      this.logger.warn(
        `Stripe ${this.mode}-mode key not set (STRIPE_SECRET_KEY${this.mode === 'test' ? '_TEST' : ''}) — ` +
          'running in simulated payment mode. Purchases and AutoPay recharges will succeed instantly without contacting Stripe.',
      );
    } else {
      this.client = new Stripe(secretKey);
    }
  }

  /** Phase 8 (optional) — see RazorpayPaymentProvider.onModuleInit for the
   * full rationale (additive, restart-to-take-effect, silently ignored if
   * the DB row is absent or malformed; BillingSettings.defaultPaymentMode
   * checked first, switching `this.mode` and re-resolving env keys before
   * the credential-override lookup below). */
  async onModuleInit(): Promise<void> {
    const settings = await this.settingsModel.findOne({ singletonKey: 'default' }).exec();
    if (settings?.defaultPaymentMode && settings.defaultPaymentMode !== this.mode) {
      this.mode = settings.defaultPaymentMode;
      this.applyEnvKeysForMode();
      this.logger.log(`Stripe mode switched to "${this.mode}" from admin-managed BillingSettings.defaultPaymentMode.`);
    }

    const dbConfig = await this.gatewayConfigModel.findOne({ provider: 'stripe', mode: this.mode, isActive: true }).exec();
    if (!dbConfig) return;

    const creds = dbConfig.credentialsEncrypted;
    const secretKey = creds.secretKey ? this.safeDecrypt(creds.secretKey) : '';
    if (!secretKey) {
      this.logger.warn('Stripe BillingGatewayConfig row found but is missing/malformed secretKey — ignoring; env-var config (if any) stands.');
      return;
    }

    this.webhookSecret = creds.webhookSecret ? this.safeDecrypt(creds.webhookSecret) : this.webhookSecret;
    this.configured = true;
    this.client = new Stripe(secretKey);
    this.logger.log('Stripe configured from admin-managed BillingGatewayConfig, overriding env vars.');
  }

  private safeDecrypt(value: string): string {
    try {
      return this.encryption.decrypt(value);
    } catch {
      return '';
    }
  }

  async createCustomer(organizationId: string, email: string, name: string): Promise<{ customerId: string }> {
    if (!this.configured || !this.client) {
      return { customerId: `sim_cust_${randomUUID()}` };
    }
    const customer = await this.client.customers.create({ email, name, metadata: { organizationId } });
    return { customerId: customer.id };
  }

  async createCheckoutOrder(
    organizationId: string,
    amount: number,
    currency: string,
    creditPackageKey: string,
  ): Promise<CreateCheckoutOrderResult> {
    // Stripe amounts are in the smallest currency unit too (cents for USD).
    const amountMinorUnits = Math.round(amount * 100);

    if (!this.configured || !this.client) {
      const orderId = `sim_order_${randomUUID()}`;
      return {
        orderId,
        simulated: true,
        checkoutParams: { orderId, amount: amountMinorUnits, currency, simulated: true },
      };
    }

    const intent = await this.client.paymentIntents.create({
      amount: amountMinorUnits,
      currency: currency.toLowerCase(),
      setup_future_usage: 'off_session',
      metadata: { organizationId, creditPackageKey },
    });
    return {
      orderId: intent.id,
      simulated: false,
      checkoutParams: { clientSecret: intent.client_secret, paymentIntentId: intent.id, amount: amountMinorUnits, currency, simulated: false },
    };
  }

  /** Unlike Razorpay, Stripe doesn't need a dedicated "authorization" order
   * shape — createCheckoutOrder above already sets setup_future_usage:
   * 'off_session' on every PaymentIntent, which already achieves silent
   * merchant-initiated recurring capability. This is a thin wrapper at a
   * nominal amount so it never represents a real purchase, matching
   * Razorpay's authorization order's intent (see confirmPaymentMethodAuthorization,
   * billing.service.ts — the caller refunds this immediately either way). */
  async createAuthorizationOrder(organizationId: string, _gatewayCustomerId: string, currency: string): Promise<CreateCheckoutOrderResult> {
    return this.createCheckoutOrder(organizationId, 1, currency, 'auto_recharge_card_authorization');
  }

  async saveMethodFromCheckout(
    _organizationId: string,
    gatewayCustomerId: string,
    gatewayPaymentId: string,
    _signature: string,
    _gatewayOrderId: string,
  ): Promise<SaveMethodResult> {
    if (!this.configured || !this.client) {
      const tokenId = `sim_token_${randomUUID()}`;
      return {
        paymentMethodId: tokenId,
        gatewayCustomerId,
        gatewayTokenIdEncrypted: this.encryption.encrypt(tokenId),
        cardLast4: '0000',
        cardNetwork: 'simulated',
      };
    }

    // gatewayPaymentId here is the PaymentIntent id created in
    // createCheckoutOrder — setup_future_usage already attached the
    // resulting PaymentMethod to the customer as a side effect of a
    // successful confirm, no separate token exchange needed.
    const intent = await this.client.paymentIntents.retrieve(gatewayPaymentId);
    const paymentMethodId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
    if (!paymentMethodId) {
      throw new Error('PaymentIntent has no attached payment method to save.');
    }
    const method = await this.client.paymentMethods.retrieve(paymentMethodId);
    return {
      paymentMethodId,
      gatewayCustomerId: (intent.customer as string) ?? gatewayCustomerId,
      gatewayTokenIdEncrypted: this.encryption.encrypt(paymentMethodId),
      cardLast4: method.card?.last4 ?? '0000',
      cardNetwork: method.card?.brand ?? 'unknown',
    };
  }

  async chargeSavedMethod(
    _organizationId: string,
    gatewayCustomerId: string,
    gatewayTokenId: string,
    amount: number,
    currency: string,
  ): Promise<ChargeResult> {
    if (!this.configured || !this.client) {
      return { success: true, paymentId: `sim_pay_${randomUUID()}`, simulated: true };
    }

    try {
      const intent = await this.client.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: currency.toLowerCase(),
        customer: gatewayCustomerId,
        payment_method: gatewayTokenId,
        off_session: true,
        confirm: true,
      });
      return { success: intent.status === 'succeeded', paymentId: intent.id, simulated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stripe charge failed';
      return { success: false, paymentId: '', simulated: false, reason: message };
    }
  }

  async confirmPayment(gatewayOrderId: string, _gatewayPaymentId: string, _signature: string): Promise<ConfirmPaymentResult> {
    if (!this.configured || !this.client) {
      return { success: true };
    }
    // Stripe has no client-relayed signature to check for this — instead
    // re-fetch the PaymentIntent directly from Stripe's own API (gatewayOrderId
    // is the PaymentIntent id — Stripe has no separate order concept) and
    // trust only what Stripe itself reports the status as.
    try {
      const intent = await this.client.paymentIntents.retrieve(gatewayOrderId);
      if (intent.status !== 'succeeded') {
        return { success: false, reason: `PaymentIntent status is "${intent.status}", not succeeded` };
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not fetch PaymentIntent status';
      return { success: false, reason: message };
    }
  }

  async refundPayment(_gatewayOrderId: string, gatewayPaymentId: string, amount: number, reason?: string): Promise<RefundResult> {
    if (!this.configured || !this.client) {
      return { success: true, gatewayRefundId: `sim_refund_${randomUUID()}`, simulated: true };
    }
    try {
      // gatewayPaymentId here is the PaymentIntent id (Stripe has no
      // separate order concept — see createCheckoutOrder). Stripe's `reason`
      // field only accepts a fixed enum (duplicate/fraudulent/requested_by_customer),
      // not freeform text, so our admin-entered reason goes in metadata instead.
      const refund = await this.client.refunds.create({
        payment_intent: gatewayPaymentId,
        amount: Math.round(amount * 100),
        metadata: reason ? { reason } : undefined,
      });
      return { success: refund.status !== 'failed' && refund.status !== 'canceled', gatewayRefundId: refund.id, simulated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stripe refund failed';
      return { success: false, simulated: false, reason: message };
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    if (!this.configured || !this.client || !this.webhookSecret) {
      return true; // simulated mode — nothing signs these payloads for real
    }
    try {
      this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
      return true;
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): GenericWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      type?: string;
      data?: { object?: { id?: string } };
    };
    const eventType = payload.type ?? 'unknown';
    // Stripe's own event names differ per gateway — normalized to the same
    // 'payment.captured'/'payment.failed' vocabulary every adapter emits,
    // so billing-webhook.controller.ts's handling logic is provider-agnostic.
    const normalizedEvent =
      eventType === 'payment_intent.succeeded'
        ? 'payment.captured'
        : eventType === 'payment_intent.payment_failed'
          ? 'payment.failed'
          : eventType;
    return {
      eventId: payload.id ?? randomUUID(),
      event: normalizedEvent,
      gatewayPaymentId: payload.data?.object?.id,
      gatewayOrderId: payload.data?.object?.id, // Stripe has no separate order id — the PaymentIntent id is both
      raw: payload,
    };
  }
}
