import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingSubscriptionsService } from './billing-subscriptions.service';
import { CouponsService } from './coupons.service';
import {
  ChargeResult,
  ConfirmPaymentResult,
  CreateCheckoutOrderResult,
  GenericWebhookEvent,
  PAYMENT_PROVIDER,
  PaymentProviderAdapter,
  RefundResult,
  SaveMethodResult,
} from './providers/payment-provider.interface';
import { BillingInvoiceCounter, BillingInvoiceCounterSchema } from './schemas/billing-invoice-counter.schema';
import { BillingInvoice, BillingInvoiceDocument, BillingInvoiceSchema } from './schemas/billing-invoice.schema';
import { BillingPlan, BillingPlanDocument, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceDocument, BillingPlanPriceSchema } from './schemas/billing-plan-price.schema';
import { BillingSettings, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventDocument, BillingSubscriptionEventSchema } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionDocument, BillingSubscriptionSchema } from './schemas/billing-subscription.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageSchema } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { PaymentMethod, PaymentMethodDocument, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import { WalletService } from './wallet.service';

// Real-Mongo integration tests (this project's established live-testing
// convention — see billing-integration.spec.ts/billing-migration.spec.ts)
// for Phase 2: BillingSubscriptionsService (checkout/cancel/listing) and
// SubscriptionRenewalService (the cron). A hand-written fake
// PaymentProviderAdapter stands in for a real gateway — createCheckoutOrder
// always returns simulated:true (exercising the same "activate immediately"
// path RazorpayPaymentProvider's own unconfigured fallback already uses in
// dev), and chargeSavedMethod's success/failure is controlled per-org via
// whether a PaymentMethod row exists, not via the fake itself.

const TEST_PREFIX = `jest-billing-subs-${Date.now()}`;

class FakePaymentProvider implements PaymentProviderAdapter {
  readonly providerKey = 'razorpay' as const;

  async createCustomer(): Promise<{ customerId: string }> {
    return { customerId: 'fake_cust' };
  }
  async createCheckoutOrder(): Promise<CreateCheckoutOrderResult> {
    return { orderId: `fake_order_${Date.now()}_${Math.random().toString(36).slice(2)}`, checkoutParams: {}, simulated: true };
  }
  async saveMethodFromCheckout(): Promise<SaveMethodResult> {
    return { paymentMethodId: 'fake_pm', gatewayCustomerId: 'fake_cust', gatewayTokenIdEncrypted: 'enc', cardLast4: '4242', cardNetwork: 'visa' };
  }
  async chargeSavedMethod(): Promise<ChargeResult> {
    return { success: true, paymentId: `fake_payment_${Date.now()}`, simulated: true };
  }
  async confirmPayment(): Promise<ConfirmPaymentResult> {
    return { success: true };
  }
  async refundPayment(): Promise<RefundResult> {
    return { success: true, gatewayRefundId: `fake_refund_${Date.now()}`, simulated: true };
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
  parseWebhookEvent(): GenericWebhookEvent {
    return { eventId: 'fake', event: 'payment.captured', raw: {} };
  }
}

describe('Subscriptions (real Mongo)', () => {
  let connection: Connection;
  let subscriptionsService: BillingSubscriptionsService;
  let renewalService: SubscriptionRenewalService;
  let encryptionService: EncryptionService;

  let planModel: Model<BillingPlanDocument>;
  let priceModel: Model<BillingPlanPriceDocument>;
  let subscriptionModel: Model<BillingSubscriptionDocument>;
  let eventModel: Model<BillingSubscriptionEventDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let paymentMethodModel: Model<PaymentMethodDocument>;
  let walletModel: Model<WalletDocument>;
  let transactionModel: Model<WalletTransactionDocument>;
  let invoiceModel: Model<BillingInvoiceDocument>;

  const createdPlanIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run subscription integration tests.');

    const configValues: Record<string, unknown> = {
      'billing.currency': 'INR',
      'billing.freeTrialCredits': 0,
      'billing.autoRechargeDefault': false,
      'billing.lowBalanceThresholdCredits': 200,
      'billing.subscriptionRenewalGraceAttempts': 2,
      encryptionKey: 'test-encryption-key-for-subscription-spec',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: BillingPlanPrice.name, schema: BillingPlanPriceSchema },
          { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
          { name: BillingSubscriptionEvent.name, schema: BillingSubscriptionEventSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: PaymentMethod.name, schema: PaymentMethodSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          // Phase 3/4 dependencies of BillingSubscriptionsService — not
          // exercised directly by these tests (no coupon code/invoice
          // assertions here, see coupons.spec.ts/billing-invoice.spec.ts for
          // those), but required for the module to compile since the
          // service now takes CouponsService/BillingInvoiceService in its
          // constructor.
          { name: Coupon.name, schema: CouponSchema },
          { name: CouponRedemption.name, schema: CouponRedemptionSchema },
          { name: BillingInvoice.name, schema: BillingInvoiceSchema },
          { name: BillingInvoiceCounter.name, schema: BillingInvoiceCounterSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
          { name: InvoiceTemplate.name, schema: InvoiceTemplateSchema },
          { name: CreditPackage.name, schema: CreditPackageSchema },
        ]),
      ],
      providers: [
        BillingSubscriptionsService,
        SubscriptionRenewalService,
        CouponsService,
        BillingInvoiceService,
        // WalletService/EncryptionService are the real classes — only the
        // gateway and config are stubbed, same split billing-integration.spec.ts uses.
        WalletService,
        EncryptionService,
        { provide: PAYMENT_PROVIDER, useValue: new FakePaymentProvider() },
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingPlan.name)).db;
    subscriptionsService = moduleRef.get(BillingSubscriptionsService);
    renewalService = moduleRef.get(SubscriptionRenewalService);
    encryptionService = moduleRef.get(EncryptionService);

    planModel = moduleRef.get(getModelToken(BillingPlan.name));
    priceModel = moduleRef.get(getModelToken(BillingPlanPrice.name));
    subscriptionModel = moduleRef.get(getModelToken(BillingSubscription.name));
    eventModel = moduleRef.get(getModelToken(BillingSubscriptionEvent.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    paymentMethodModel = moduleRef.get(getModelToken(PaymentMethod.name));
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    invoiceModel = moduleRef.get(getModelToken(BillingInvoice.name));
  });

  afterAll(async () => {
    await planModel.deleteMany({ _id: { $in: createdPlanIds } });
    await priceModel.deleteMany({ planId: { $in: createdPlanIds } });
    await subscriptionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await eventModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentMethodModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await invoiceModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  async function createPlanWithPrice(opts: {
    key: string;
    isPublic?: boolean;
    currencyCode?: string;
    billingCycle?: 'monthly' | 'yearly' | 'weekly' | 'quarterly' | 'one_time';
    amount?: number;
    creditsGranted?: number;
  }) {
    const plan = await planModel.create({ key: opts.key, name: opts.key, active: true, isPublic: opts.isPublic ?? true, sortOrder: 0 });
    createdPlanIds.push(plan._id.toString());
    const price = await priceModel.create({
      planId: plan._id.toString(),
      currencyCode: opts.currencyCode ?? 'INR',
      billingCycle: opts.billingCycle ?? 'monthly',
      amount: opts.amount ?? 999,
      creditsGranted: opts.creditsGranted ?? 5000,
      effectiveFrom: new Date(),
      effectiveTo: null,
      active: true,
    });
    return { plan, price };
  }

  describe('checkout (simulated gateway)', () => {
    it('activates the subscription immediately, grants credits, and sets a ~1 month period', async () => {
      const { plan, price } = await createPlanWithPrice({ key: `${TEST_PREFIX}-pro` });
      const org = `${TEST_PREFIX}-org-checkout`;

      const result = await subscriptionsService.checkout(org, 'user-1', { planId: plan._id.toString(), priceId: price._id.toString() });

      expect(result.simulated).toBe(true);
      expect(result.activatedImmediately).toBe(true);
      expect(result.subscription?.status).toBe('active');
      expect(result.subscription?.plan?.key).toBe(plan.key);
      expect(result.subscription?.price?.creditsGranted).toBe(5000);

      const wallet = await walletModel.findOne({ organizationId: org });
      expect(wallet?.balanceCredits).toBe(5000);

      const grantRow = await transactionModel.findOne({ organizationId: org, type: 'SUBSCRIPTION_GRANT' });
      expect(grantRow).toBeTruthy();
      expect(grantRow?.amountCredits).toBe(5000);

      const createdEvent = await eventModel.findOne({ organizationId: org, type: 'created' });
      expect(createdEvent).toBeTruthy();

      const daysUntilPeriodEnd =
        (result.subscription!.currentPeriodEnd.getTime() - result.subscription!.currentPeriodStart.getTime()) / 86_400_000;
      expect(daysUntilPeriodEnd).toBeGreaterThanOrEqual(27);
      expect(daysUntilPeriodEnd).toBeLessThanOrEqual(31);
    });

    it('rejects re-checkout of the exact same plan already subscribed to', async () => {
      const org = `${TEST_PREFIX}-org-checkout`; // already subscribed (first test in this suite)
      const currentSubscription = await subscriptionModel.findOne({ organizationId: org, status: 'active' }).exec();
      const currentPrice = await priceModel.findOne({ planId: currentSubscription!.planId }).exec();

      await expect(
        subscriptionsService.checkout(org, 'user-1', { planId: currentSubscription!.planId, priceId: currentPrice!._id.toString() }),
      ).rejects.toThrow('Already subscribed to this plan.');
    });

    it('switching to a DIFFERENT plan while one is active supersedes the old one instead of rejecting', async () => {
      const org = `${TEST_PREFIX}-org-checkout`; // already active on the -pro plan from the first test
      const before = await subscriptionModel.findOne({ organizationId: org, status: 'active' }).exec();
      const oldSubscriptionId = before!._id.toString();

      const { plan: upgradePlan, price: upgradePrice } = await createPlanWithPrice({ key: `${TEST_PREFIX}-pro-upgrade`, amount: 1999, creditsGranted: 8000 });
      const result = await subscriptionsService.checkout(org, 'user-1', {
        planId: upgradePlan._id.toString(),
        priceId: upgradePrice._id.toString(),
      });

      expect(result.activatedImmediately).toBe(true);
      expect(result.subscription?.plan?.key).toBe(upgradePlan.key);
      expect(result.subscription?.id).not.toBe(oldSubscriptionId);

      const oldSubscription = await subscriptionModel.findById(oldSubscriptionId).exec();
      expect(oldSubscription?.status).toBe('canceled');
      const supersededEvent = await eventModel.findOne({ subscriptionId: oldSubscriptionId, type: 'canceled' }).exec();
      expect(supersededEvent?.metadata.reason).toBe('superseded_by_upgrade');

      // Exactly one active subscription for the org — the unique partial
      // index invariant held throughout the swap.
      const activeCount = await subscriptionModel.countDocuments({ organizationId: org, status: { $in: ['trialing', 'active', 'past_due'] } });
      expect(activeCount).toBe(1);

      // Prepaid wallet balance is additive, not reset — 5000 from the
      // original plan (first test in this suite) + 8000 from the upgrade.
      const wallet = await walletModel.findOne({ organizationId: org }).exec();
      expect(wallet?.balanceCredits).toBe(13000);
    });

    it('rejects a one_time price for a subscription checkout', async () => {
      const { plan, price } = await createPlanWithPrice({ key: `${TEST_PREFIX}-onetime`, billingCycle: 'one_time' });
      const org = `${TEST_PREFIX}-org-onetime`;

      await expect(
        subscriptionsService.checkout(org, 'user-1', { planId: plan._id.toString(), priceId: price._id.toString() }),
      ).rejects.toThrow();
    });
  });

  describe('listPublicPlans', () => {
    it('only returns active + isPublic plans, with prices scoped to the requested currency', async () => {
      const publicPlan = await createPlanWithPrice({ key: `${TEST_PREFIX}-list-public`, currencyCode: 'INR' });
      await createPlanWithPrice({ key: `${TEST_PREFIX}-list-private`, isPublic: false, currencyCode: 'INR' });

      const listing = await subscriptionsService.listPublicPlans('INR');
      const keys = listing.map((p) => p.key);
      expect(keys).toContain(publicPlan.plan.key);
      expect(keys).not.toContain(`${TEST_PREFIX}-list-private`);

      const found = listing.find((p) => p.key === publicPlan.plan.key)!;
      expect(found.prices).toHaveLength(1);
      expect(found.prices[0].currencyCode).toBe('INR');
    });
  });

  describe('cancel', () => {
    it('sets cancelAtPeriodEnd without immediately changing status', async () => {
      const org = `${TEST_PREFIX}-org-checkout`; // already has an active subscription

      const result = await subscriptionsService.cancel(org);
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.status).toBe('active'); // entitlement kept through period end

      const canceledEvent = await eventModel.findOne({ organizationId: org, type: 'canceled' });
      expect(canceledEvent).toBeTruthy();
    });
  });

  describe('SubscriptionRenewalService', () => {
    it('flips a cancelAtPeriodEnd subscription to canceled at period end without charging', async () => {
      const org = `${TEST_PREFIX}-org-checkout`; // canceled in the previous test
      await subscriptionModel.updateOne({ organizationId: org }, { $set: { currentPeriodEnd: new Date(Date.now() - 60_000) } });

      const paymentCountBefore = await paymentRecordModel.countDocuments({ organizationId: org });
      await renewalService.processDueRenewals();

      const subscription = await subscriptionModel.findOne({ organizationId: org });
      expect(subscription?.status).toBe('canceled');
      const paymentCountAfter = await paymentRecordModel.countDocuments({ organizationId: org });
      expect(paymentCountAfter).toBe(paymentCountBefore); // no renewal charge attempted
    });

    it('renews successfully when a default payment method exists — advances the period and grants credits again', async () => {
      const { plan, price } = await createPlanWithPrice({ key: `${TEST_PREFIX}-pro-renew` });
      const org = `${TEST_PREFIX}-org-renew`;

      const checkoutResult = await subscriptionsService.checkout(org, 'user-1', {
        planId: plan._id.toString(),
        priceId: price._id.toString(),
      });
      await paymentMethodModel.create({
        organizationId: org,
        provider: 'razorpay',
        gatewayCustomerId: 'fake_cust',
        // Must be real ciphertext — SubscriptionRenewalService decrypts this
        // with the real EncryptionService before charging (same as
        // AutoPayService.attemptRecharge), so a fake plain string here would
        // throw "Malformed encrypted payload" before the charge ever happens.
        gatewayTokenIdEncrypted: encryptionService.encrypt('fake-gateway-token'),
        cardLast4: '4242',
        cardNetwork: 'visa',
        isDefault: true,
      });

      const originalPeriodEnd = checkoutResult.subscription!.currentPeriodEnd;
      await subscriptionModel.updateOne({ organizationId: org }, { $set: { currentPeriodEnd: new Date(Date.now() - 60_000) } });

      await renewalService.processDueRenewals();

      const subscription = await subscriptionModel.findOne({ organizationId: org });
      expect(subscription?.status).toBe('active');
      expect(subscription?.renewalFailureCount).toBe(0);
      expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(originalPeriodEnd.getTime() - 60_000);

      const wallet = await walletModel.findOne({ organizationId: org });
      expect(wallet?.balanceCredits).toBe(10000); // 5000 at checkout + 5000 at renewal

      const renewalRecord = await paymentRecordModel.findOne({ organizationId: org, type: 'subscription_renewal' });
      expect(renewalRecord?.status).toBe('captured');

      const renewedEvent = await eventModel.findOne({ organizationId: org, type: 'renewed' });
      expect(renewedEvent).toBeTruthy();
    });

    it('marks past_due with no payment method, then expired after exhausting the grace attempts', async () => {
      const { plan, price } = await createPlanWithPrice({ key: `${TEST_PREFIX}-pro-fail` });
      const org = `${TEST_PREFIX}-org-fail`;

      await subscriptionsService.checkout(org, 'user-1', { planId: plan._id.toString(), priceId: price._id.toString() });
      await subscriptionModel.updateOne({ organizationId: org }, { $set: { currentPeriodEnd: new Date(Date.now() - 60_000) } });

      // Attempt 1 — no payment method on file.
      await renewalService.processDueRenewals();
      let subscription = await subscriptionModel.findOne({ organizationId: org });
      expect(subscription?.status).toBe('past_due');
      expect(subscription?.renewalFailureCount).toBe(1);

      // Attempt 2 — grace attempts configured to 2, so this exhausts it.
      await renewalService.processDueRenewals();
      subscription = await subscriptionModel.findOne({ organizationId: org });
      expect(subscription?.status).toBe('expired');
      expect(subscription?.renewalFailureCount).toBe(2);

      // Attempt 3 — expired subscriptions are no longer selected at all.
      await renewalService.processDueRenewals();
      subscription = await subscriptionModel.findOne({ organizationId: org });
      expect(subscription?.renewalFailureCount).toBe(2); // unchanged

      const failedEvent = await eventModel.findOne({ organizationId: org, type: 'renewal_failed' });
      expect(failedEvent?.metadata.reason).toBe('no_payment_method');
      const expiredEvent = await eventModel.findOne({ organizationId: org, type: 'expired' });
      expect(expiredEvent).toBeTruthy();
    });
  });
});
