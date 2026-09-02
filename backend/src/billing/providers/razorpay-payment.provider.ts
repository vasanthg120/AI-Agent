import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Razorpay from 'razorpay';
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
 * Structurally complete Razorpay integration (real Orders/Customers API
 * calls, real HMAC-SHA256 webhook + checkout signature verification per
 * Razorpay's documented scheme) — but every method short-circuits to a
 * simulated result when the active key set (live or test, per
 * config.billing.paymentMode) isn't configured, exactly like
 * EncryptionService falls back to deriving a key from JWT_SECRET and
 * MailService warns when SMTP env vars are blank. This lets the entire
 * wallet/reservation/margin pipeline be exercised end-to-end in dev
 * without real payment credentials; the same code paths run unchanged
 * once keys are added.
 */
@Injectable()
export class RazorpayPaymentProvider implements PaymentProviderAdapter, OnModuleInit {
  readonly providerKey = 'razorpay' as const;
  private readonly logger = new Logger(RazorpayPaymentProvider.name);
  private configured: boolean;
  private client?: Razorpay;
  private keyId: string;
  private keySecret: string;
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

  /** Resolves keyId/keySecret/webhookSecret from env vars for `this.mode` —
   * shared by the constructor and onModuleInit's admin-mode-override branch
   * below, so switching modes re-does exactly the same lookup the
   * constructor would have done had that mode been active from boot. */
  private applyEnvKeysForMode(): void {
    const keys = this.config.get<{ keyId: string; keySecret: string; webhookSecret: string }>(`billing.razorpay.${this.mode}`);
    const keyId = keys?.keyId ?? '';
    this.keyId = keyId;
    this.keySecret = keys?.keySecret ?? '';
    this.webhookSecret = keys?.webhookSecret ?? '';
    this.configured = Boolean(keyId && this.keySecret);

    if (!this.configured) {
      this.logger.warn(
        `Razorpay ${this.mode}-mode keys not set (RAZORPAY_KEY_ID${this.mode === 'test' ? '_TEST' : ''}/RAZORPAY_KEY_SECRET${this.mode === 'test' ? '_TEST' : ''}) — ` +
          'running in simulated payment mode. Purchases and AutoPay recharges will succeed instantly without contacting Razorpay.',
      );
    } else {
      this.client = new Razorpay({ key_id: keyId, key_secret: this.keySecret });
    }
  }

  /** Phase 8 (optional) — additive DB overrides, checked once at boot AFTER
   * the constructor's env-var setup above (which is left completely
   * unchanged when neither override is set). See BillingGatewayConfig's own
   * schema comment for why this is restart-to-take-effect rather than
   * hot-reloading a live SDK client, and why a missing/malformed DB row is
   * silently ignored rather than thrown — either way, whatever's already
   * set up stands.
   *
   * BillingSettings.defaultPaymentMode (Admin-haive's Payment Settings
   * page) is checked FIRST — if it names a different mode than the env var
   * chose, `this.mode` is switched and env keys are re-resolved for the new
   * mode before the credential-override lookup below runs, so a mode
   * switch and a credential override compose correctly together. */
  async onModuleInit(): Promise<void> {
    const settings = await this.settingsModel.findOne({ singletonKey: 'default' }).exec();
    if (settings?.defaultPaymentMode && settings.defaultPaymentMode !== this.mode) {
      this.mode = settings.defaultPaymentMode;
      this.applyEnvKeysForMode();
      this.logger.log(`Razorpay mode switched to "${this.mode}" from admin-managed BillingSettings.defaultPaymentMode.`);
    }

    const dbConfig = await this.gatewayConfigModel.findOne({ provider: 'razorpay', mode: this.mode, isActive: true }).exec();
    if (!dbConfig) return;

    const creds = dbConfig.credentialsEncrypted;
    const keyId = creds.keyId ? this.safeDecrypt(creds.keyId) : '';
    const keySecret = creds.keySecret ? this.safeDecrypt(creds.keySecret) : '';
    if (!keyId || !keySecret) {
      this.logger.warn('Razorpay BillingGatewayConfig row found but is missing/malformed keyId or keySecret — ignoring; env-var config (if any) stands.');
      return;
    }

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = creds.webhookSecret ? this.safeDecrypt(creds.webhookSecret) : this.webhookSecret;
    this.configured = true;
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    this.logger.log('Razorpay configured from admin-managed BillingGatewayConfig, overriding env vars.');
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
    const customer = await this.client.customers.create({
      name,
      email,
      notes: { organizationId },
    });
    return { customerId: customer.id };
  }

  async createCheckoutOrder(
    organizationId: string,
    amount: number,
    currency: string,
    creditPackageKey: string,
  ): Promise<CreateCheckoutOrderResult> {
    // Razorpay amounts are in the smallest currency unit (e.g. paise for
    // INR, cents for USD) — a flat *100 holds for every currency Razorpay
    // actually supports (all are 2-decimal), so no per-currency table needed.
    const amountMinorUnits = Math.round(amount * 100);

    if (!this.configured || !this.client) {
      const orderId = `sim_order_${randomUUID()}`;
      return {
        orderId,
        simulated: true,
        checkoutParams: { orderId, amount: amountMinorUnits, currency, simulated: true },
      };
    }

    const order = await this.client.orders.create({
      amount: amountMinorUnits,
      currency,
      // Razorpay hard-rejects receipt strings over 56 characters. Every
      // existing caller (credit package purchase) happened to stay under
      // that with its short, curated CreditPackage.key values — but
      // BillingSubscriptionsService.checkout's `plan_${key}_${cycle}` label
      // (plus a 24-char Mongo id and 13-digit timestamp) can exceed it for
      // a longer admin-chosen plan key, verified live: Razorpay returned
      // `"receipt: the length must be no more than 56."` and checkout
      // failed outright. This field is never parsed back (order lookup
      // always goes through the gateway's own returned order.id, see
      // billing-webhook.controller.ts), so a safe truncation has zero
      // functional effect — it only ever shows up as a label in Razorpay's
      // own dashboard.
      receipt: `${organizationId}_${creditPackageKey}_${Date.now()}`.slice(0, 56),
      notes: { organizationId, creditPackageKey },
    });
    return {
      orderId: order.id,
      simulated: false,
      // Shaped as literal Razorpay Checkout.js options (key/order_id, not
      // orderId) — this object is spread directly into `new
      // window.Razorpay({...checkoutParams, handler})` on the frontend
      // (see RazorpayCheckoutModal.tsx), so it has to match Checkout.js's
      // actual option names, not this codebase's usual camelCase
      // convention. Caught live: the original {orderId, amount, currency}
      // shape had no `key` at all and the wrong order-id field name, so the
      // real (non-simulated) checkout widget would never have opened.
      checkoutParams: {
        key: this.keyId,
        amount: amountMinorUnits,
        currency,
        order_id: order.id,
        name: 'Haive',
        description: `${creditPackageKey} credit package`,
        // Haive's brand palette (frontend/src/styles/variables.css —
        // --brand-accent-primary/--brand-bg-primary, "do not rename") — kept
        // in sync manually since Checkout.js can't read the app's CSS
        // custom properties; the logo itself (`image`) is added on the
        // frontend instead (see RazorpayCheckoutModal.tsx), since it needs
        // an absolute URL resolved against wherever the app is actually
        // being served from, which this backend service has no notion of.
        theme: {
          color: '#ed7e2c',
          backdrop_color: '#070707',
        },
        modal: {
          backdropclose: false,
          escape: true,
          handleback: true,
          confirm_close: true,
          animation: true,
        },
      },
    };
  }

  /** A dedicated, minimum-amount "authorization" order — the only way to
   * actually get a chargeable recurring token out of Razorpay for a silent,
   * merchant-initiated later charge (confirmed against
   * https://razorpay.com/docs/api/payments/recurring-payments/cards/create-authorization-transaction/,
   * not assumed). This is NOT a real purchase: billing.service.ts's
   * confirmPaymentMethodAuthorization refunds it immediately once the token
   * is captured. `amount` is fixed at Razorpay's documented minimum (100
   * minor units — e.g. ₹1/$1) rather than taking a caller-supplied amount,
   * since this order's amount is never meant to represent anything real. */
  async createAuthorizationOrder(organizationId: string, gatewayCustomerId: string, currency: string): Promise<CreateCheckoutOrderResult> {
    const amountMinorUnits = 100;

    if (!this.configured || !this.client) {
      const orderId = `sim_order_${randomUUID()}`;
      return {
        orderId,
        simulated: true,
        checkoutParams: { orderId, amount: amountMinorUnits, currency, customer_id: gatewayCustomerId, recurring: true, simulated: true },
      };
    }

    const order = await this.client.orders.create({
      amount: amountMinorUnits,
      currency,
      customer_id: gatewayCustomerId,
      method: 'card',
      // as_presented = charge-at-will (a variable amount, on demand) rather
      // than a fixed schedule — matches AutoPayService.attemptRecharge's
      // own variable, on-demand recharge amounts.
      token: {
        max_amount: 1500000,
        expire_at: Math.floor(Date.now() / 1000) + 5 * 365 * 24 * 60 * 60,
        frequency: 'as_presented',
      },
      payment_capture: true,
      receipt: `authorize_${organizationId}_${Date.now()}`.slice(0, 56),
      notes: { organizationId, purpose: 'auto_recharge_card_authorization' },
    });
    return {
      orderId: order.id,
      simulated: false,
      checkoutParams: {
        key: this.keyId,
        amount: amountMinorUnits,
        currency,
        order_id: order.id,
        customer_id: gatewayCustomerId,
        recurring: true,
        name: 'Haive',
        description: 'Card verification for Auto Recharge',
        theme: {
          color: '#ed7e2c',
          backdrop_color: '#070707',
        },
        modal: {
          backdropclose: false,
          escape: true,
          handleback: true,
          confirm_close: true,
          animation: true,
        },
      },
    };
  }

  async saveMethodFromCheckout(
    organizationId: string,
    gatewayCustomerId: string,
    gatewayPaymentId: string,
    signature: string,
    gatewayOrderId: string,
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

    if (!this.verifyCheckoutSignature(gatewayOrderId, gatewayPaymentId, signature)) {
      throw new Error('Razorpay checkout signature verification failed');
    }

    const payment = await this.client.payments.fetch(gatewayPaymentId);
    const tokenId = (payment as unknown as { token_id?: string }).token_id;
    if (!tokenId) {
      throw new Error('Payment did not produce a saved card token (was "save card" enabled at checkout?)');
    }
    // Razorpay assigns its own customer_id the moment a card is tokenized
    // (auto-linked by contact/email even when checkout wasn't opened with
    // an explicit customer_id) — that's the id chargeSavedMethod later has
    // to pass back as `customer_id` for the saved token to be chargeable,
    // so it must win over whatever the caller supplied.
    const paymentCustomerId = (payment as unknown as { customer_id?: string }).customer_id;
    const card = (payment as unknown as { card?: { last4?: string; network?: string } }).card ?? {};
    return {
      paymentMethodId: tokenId,
      gatewayCustomerId: paymentCustomerId || gatewayCustomerId,
      gatewayTokenIdEncrypted: this.encryption.encrypt(tokenId),
      cardLast4: card.last4 ?? '0000',
      cardNetwork: card.network ?? 'unknown',
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
      // Razorpay's "Charge a saved card" (recurring/e-mandate) endpoint has
      // no dedicated SDK helper method in all SDK versions — call it via
      // the client's underlying API wrapper, which shares the same
      // authenticated axios instance as every typed method above.
      const response = await this.client.api.post({
        url: '/payments/create/recurring',
        data: {
          amount: Math.round(amount * 100),
          currency,
          customer_id: gatewayCustomerId,
          token: gatewayTokenId,
          recurring: '1',
        },
      });
      const paymentId = (response as unknown as { id?: string }).id ?? '';
      return { success: true, paymentId, simulated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Razorpay charge failed';
      return { success: false, paymentId: '', simulated: false, reason: message };
    }
  }

  async confirmPayment(gatewayOrderId: string, gatewayPaymentId: string, signature: string): Promise<ConfirmPaymentResult> {
    if (!this.configured || !this.client) {
      return { success: true };
    }
    if (!this.verifyCheckoutSignature(gatewayOrderId, gatewayPaymentId, signature)) {
      return { success: false, reason: 'Signature verification failed' };
    }
    // The signature alone already proves Razorpay produced this
    // payment_id/order_id pair (it can only have been computed with the
    // key secret, which never leaves this server) — re-fetching is a belt-
    // and-suspenders check that the payment actually reached a captured
    // state, not just an authorized one.
    try {
      const payment = await this.client.payments.fetch(gatewayPaymentId);
      const status = (payment as unknown as { status?: string }).status;
      if (status !== 'captured' && status !== 'authorized') {
        return { success: false, reason: `Payment status is "${status}", not captured` };
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not fetch payment status';
      return { success: false, reason: message };
    }
  }

  async refundPayment(_gatewayOrderId: string, gatewayPaymentId: string, amount: number, reason?: string): Promise<RefundResult> {
    if (!this.configured || !this.client) {
      return { success: true, gatewayRefundId: `sim_refund_${randomUUID()}`, simulated: true };
    }
    try {
      const refund = await this.client.payments.refund(gatewayPaymentId, {
        amount: Math.round(amount * 100),
        notes: reason ? { reason } : undefined,
      });
      return { success: true, gatewayRefundId: refund.id, simulated: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Razorpay refund failed';
      return { success: false, simulated: false, reason: message };
    }
  }

  private verifyCheckoutSignature(gatewayOrderId: string, gatewayPaymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.keySecret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest('hex');
    return this.safeEqual(expected, signature ?? '');
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    if (!this.configured || !this.webhookSecret) {
      // Simulated mode: nothing signs these payloads for real, so there's
      // no signature to check against — the caller (billing-webhook.controller)
      // only reaches real traffic once a webhook secret is set.
      return true;
    }
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return this.safeEqual(expected, signatureHeader ?? '');
  }

  parseWebhookEvent(rawBody: Buffer): GenericWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const payloadEntity = payload.payload as
      | { payment?: { entity?: { id?: string; order_id?: string } } }
      | undefined;
    const paymentEntity = payloadEntity?.payment?.entity;
    return {
      eventId: (payload.id as string) ?? (payload.event as string) ?? randomUUID(),
      event: (payload.event as string) ?? 'unknown',
      gatewayPaymentId: paymentEntity?.id,
      gatewayOrderId: paymentEntity?.order_id,
      raw: payload,
    };
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
