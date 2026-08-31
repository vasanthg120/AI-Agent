import { BadRequestException, Controller, Headers, Logger, Param, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { Model } from 'mongoose';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingSubscriptionsService } from './billing-subscriptions.service';
import { CouponsService } from './coupons.service';
import { CashfreePaymentProvider } from './providers/cashfree-payment.provider';
import { PaymentProviderAdapter, PaymentProviderKey } from './providers/payment-provider.interface';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { WalletService } from './wallet.service';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { WebhookEvent, WebhookEventDocument } from './schemas/webhook-event.schema';

// No JwtAuthGuard — the gateway itself is the caller, authenticated by its
// own signature scheme instead of a bearer token, same reason
// backend/src/outlook/outlook.controller.ts's OAuth callback routes have no
// guard either. One route per gateway (matches how each gateway's own
// dashboard wants a fixed webhook URL registered), all delegating to one
// shared handler — the specific concrete adapter used for
// verify/parse is looked up by the `:provider` route param, independent of
// which one is currently PAYMENT_PROVIDER-active, so a gateway's webhook
// still gets processed correctly even mid-migration to a different active
// provider.
@Controller('billing/webhooks')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);
  private readonly adapters: Record<PaymentProviderKey, PaymentProviderAdapter>;

  constructor(
    @InjectModel(WebhookEvent.name) private webhookEventModel: Model<WebhookEventDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    razorpay: RazorpayPaymentProvider,
    stripe: StripePaymentProvider,
    cashfree: CashfreePaymentProvider,
    private wallet: WalletService,
    private subscriptions: BillingSubscriptionsService,
    private coupons: CouponsService,
    private invoices: BillingInvoiceService,
  ) {
    this.adapters = { razorpay, stripe, cashfree };
  }

  @Post('razorpay')
  handleRazorpay(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature: string) {
    return this.handle('razorpay', req, signature);
  }

  @Post('stripe')
  handleStripe(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    return this.handle('stripe', req, signature);
  }

  @Post('cashfree')
  handleCashfree(@Req() req: RawBodyRequest<Request>, @Headers('x-webhook-signature') signature: string) {
    return this.handle('cashfree', req, signature);
  }

  private async handle(provider: PaymentProviderKey, req: RawBodyRequest<Request>, signature: string) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException('Missing request body');

    const adapter = this.adapters[provider];
    if (!adapter.verifyWebhookSignature(rawBody, signature, req.headers as Record<string, string>)) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = adapter.parseWebhookEvent(rawBody);

    // Idempotency: a duplicate delivery of the same event id hits Mongo's
    // unique-index duplicate-key error on insert and is dropped here,
    // before any credit is ever granted twice. Scoped per-provider since
    // each gateway mints its own event id namespace.
    try {
      await this.webhookEventModel.create({ eventId: `${provider}:${event.eventId}`, provider, payload: event.raw });
    } catch (err) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        this.logger.log(`Duplicate ${provider} webhook delivery for event ${event.eventId} — already processed, skipping.`);
        return { ok: true, duplicate: true };
      }
      throw err;
    }

    if (!event.gatewayOrderId) {
      this.logger.warn(`${provider} webhook event ${event.eventId} (${event.event}) carried no order id — nothing to reconcile.`);
      return { ok: true };
    }

    const record = await this.paymentRecordModel.findOne({ provider, gatewayOrderId: event.gatewayOrderId });
    if (!record) {
      this.logger.warn(`${provider} webhook event ${event.eventId} referenced unknown order ${event.gatewayOrderId}.`);
      return { ok: true };
    }

    if (event.event === 'payment.captured' && record.status !== 'captured') {
      record.status = 'captured';
      record.gatewayPaymentId = event.gatewayPaymentId;
      record.rawWebhookPayload = event.raw;
      await record.save();

      if (record.type === 'subscription_checkout') {
        // Grants credits AND creates the BillingSubscription itself — see
        // BillingSubscriptionsService.activateFromCheckoutPayment. Safe to
        // race BillingController's /subscription/confirm for the same
        // payment: both paths only reach here after independently winning
        // the atomic status!=='captured' guard above (record.save() just
        // persisted the flip this handler itself performed), so whichever
        // of the two actually got here first is the only one that will
        // observe subscriptionId unset and create the subscription;
        // activateFromCheckoutPayment is idempotent either way.
        await this.subscriptions.activateFromCheckoutPayment(record, 'system');
      } else if (record.type !== 'subscription_renewal') {
        // 'purchase' | 'autopay' — a flat credit grant onto the wallet.
        // 'subscription_renewal' is deliberately excluded: those records are
        // created AND flipped to 'captured' synchronously inside
        // subscription-renewal.service.ts's own chargeSavedMethod call
        // (same direct-charge shape AutoPayService already uses, not a
        // checkout order), so by the time any webhook for that same charge
        // could arrive, record.status is already 'captured' and the
        // `status !== 'captured'` guard above has already short-circuited
        // this whole block — this branch exists only so a future change to
        // how renewals are charged can't silently double-grant credits here.
        await this.wallet.applyLedgerEntry(record.organizationId, record.type === 'autopay' ? 'AUTO_RECHARGE' : 'PURCHASE', record.creditsGranted, {
          paymentRecordId: record._id.toString(),
          metadata: { packageKey: record.creditPackageId, provider, gatewayPaymentId: event.gatewayPaymentId, simulated: false },
          createdBy: 'system',
        });
        await this.coupons.recordRedemption(record, 'system', 'credit_purchase');
        await this.invoices.generateForPaymentRecord(record);
      }
    } else if (event.event === 'payment.failed' && record.status !== 'failed') {
      record.status = 'failed';
      record.rawWebhookPayload = event.raw;
      await record.save();
    }

    return { ok: true };
  }
}
