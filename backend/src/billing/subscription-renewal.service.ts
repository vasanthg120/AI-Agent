import { Cron, CronExpression } from '@nestjs/schedule';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PAYMENT_PROVIDER, PaymentProviderAdapter } from './providers/payment-provider.interface';
import { WalletService } from './wallet.service';
import { addBillingCycle, RecurringBillingCycle } from './billing-cycle.util';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingPlanPrice, BillingPlanPriceDocument } from './schemas/billing-plan-price.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventDocument } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionDocument } from './schemas/billing-subscription.schema';
import { PaymentMethod, PaymentMethodDocument } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';

/**
 * Cron-driven subscription renewal — NOT gateway-native recurring billing.
 * Every billing cycle, this charges the org's saved default PaymentMethod
 * directly (the exact same chargeSavedMethod call AutoPayService.attemptRecharge
 * already makes) rather than relying on Stripe/Razorpay/Cashfree's own
 * subscription objects, so the same PaymentProviderAdapter interface covers
 * one-off purchases, AutoPay, and subscriptions uniformly.
 *
 * Entirely independent of the live chat-billing path — reserve/settle/
 * release (see reservation.service.ts) never call anything here and are
 * never called from here. A subscription's only interaction with the wallet
 * is a plain SUBSCRIPTION_GRANT credit on each successful renewal, same as
 * any other credit grant.
 */
@Injectable()
export class SubscriptionRenewalService {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

  constructor(
    @InjectModel(BillingSubscription.name) private subscriptionModel: Model<BillingSubscriptionDocument>,
    @InjectModel(BillingSubscriptionEvent.name) private eventModel: Model<BillingSubscriptionEventDocument>,
    @InjectModel(BillingPlanPrice.name) private priceModel: Model<BillingPlanPriceDocument>,
    @InjectModel(PaymentMethod.name) private paymentMethodModel: Model<PaymentMethodDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProviderAdapter,
    private wallet: WalletService,
    private encryption: EncryptionService,
    private invoices: BillingInvoiceService,
    private config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processDueRenewals(): Promise<void> {
    const due = await this.subscriptionModel
      .find({ status: { $in: ['active', 'past_due'] }, currentPeriodEnd: { $lte: new Date() } })
      .limit(500)
      .exec();
    for (const subscription of due) {
      try {
        await this.processOne(subscription);
      } catch (err) {
        this.logger.error(`Renewal processing failed for subscription ${subscription._id.toString()}: ${(err as Error).message}`);
      }
    }
  }

  private async processOne(subscription: BillingSubscriptionDocument): Promise<void> {
    if (subscription.cancelAtPeriodEnd) {
      subscription.status = 'canceled';
      await subscription.save();
      await this.eventModel.create({
        subscriptionId: subscription._id.toString(),
        organizationId: subscription.organizationId,
        type: 'canceled',
        metadata: { reason: 'period_end' },
      });
      return;
    }

    const price = await this.priceModel.findById(subscription.planPriceId).exec();
    if (!price) {
      await this.recordFailure(subscription, 'price_missing');
      return;
    }

    const method = await this.paymentMethodModel.findOne({ organizationId: subscription.organizationId, isDefault: true }).exec();
    if (!method) {
      await this.recordFailure(subscription, 'no_payment_method');
      return;
    }
    // Same reasoning as AutoPayService.attemptRecharge — a saved token only
    // makes sense against the gateway that issued it.
    if (method.provider !== this.paymentProvider.providerKey) {
      await this.recordFailure(subscription, 'payment_method_provider_mismatch');
      return;
    }

    const wallet = await this.wallet.getOrCreateWallet(subscription.organizationId);
    const record = await this.paymentRecordModel.create({
      organizationId: subscription.organizationId,
      walletId: wallet._id.toString(),
      type: 'subscription_renewal',
      provider: this.paymentProvider.providerKey,
      subscriptionPlanId: subscription.planId,
      subscriptionPriceId: subscription.planPriceId,
      subscriptionId: subscription._id.toString(),
      gatewayOrderId: `sub_renewal_${subscription._id.toString()}_${Date.now()}`,
      amount: price.amount,
      currency: price.currencyCode,
      creditsGranted: price.creditsGranted,
      status: 'created',
    });

    const charge = await this.paymentProvider.chargeSavedMethod(
      subscription.organizationId,
      method.gatewayCustomerId,
      this.encryption.decrypt(method.gatewayTokenIdEncrypted),
      price.amount,
      price.currencyCode,
    );

    if (!charge.success) {
      record.status = 'failed';
      await record.save();
      await this.recordFailure(subscription, charge.reason ?? 'charge_failed');
      return;
    }

    record.status = 'captured';
    record.gatewayPaymentId = charge.paymentId;
    record.simulated = charge.simulated;
    await record.save();

    await this.wallet.applyLedgerEntry(subscription.organizationId, 'SUBSCRIPTION_GRANT', price.creditsGranted, {
      paymentRecordId: record._id.toString(),
      metadata: { planId: subscription.planId, priceId: subscription.planPriceId, billingCycle: price.billingCycle, renewal: true },
      createdBy: 'system',
    });
    await this.invoices.generateForPaymentRecord(record);

    // New period start = the period that just ended; new period end = that
    // date plus one cycle. Order matters here: currentPeriodStart is set
    // from the pre-mutation currentPeriodEnd before currentPeriodEnd itself
    // is overwritten on the next line.
    subscription.status = 'active';
    subscription.currentPeriodStart = subscription.currentPeriodEnd;
    subscription.currentPeriodEnd = addBillingCycle(subscription.currentPeriodEnd, price.billingCycle as RecurringBillingCycle);
    subscription.lastRenewalPaymentRecordId = record._id.toString();
    subscription.renewalFailureCount = 0;
    await subscription.save();

    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId: subscription.organizationId,
      type: 'renewed',
      metadata: { paymentRecordId: record._id.toString(), creditsGranted: price.creditsGranted },
    });
  }

  /** currentPeriodEnd is deliberately left untouched on failure — the
   * subscription stays due and is picked up again on the next cron tick
   * (hourly) until either it succeeds or renewalFailureCount crosses
   * config.billing.subscriptionRenewalGraceAttempts, at which point it's
   * marked 'expired' and the query in processDueRenewals stops selecting it. */
  private async recordFailure(subscription: BillingSubscriptionDocument, reason: string): Promise<void> {
    const maxAttempts = this.config.get<number>('billing.subscriptionRenewalGraceAttempts') ?? 3;
    subscription.renewalFailureCount += 1;
    subscription.status = subscription.renewalFailureCount >= maxAttempts ? 'expired' : 'past_due';
    await subscription.save();

    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId: subscription.organizationId,
      type: subscription.status === 'expired' ? 'expired' : 'renewal_failed',
      metadata: { reason, attempt: subscription.renewalFailureCount },
    });

    this.logger.warn(
      `Subscription ${subscription._id.toString()} renewal failed (${reason}), attempt ${subscription.renewalFailureCount}/${maxAttempts} — status now ${subscription.status}.`,
    );
  }
}
