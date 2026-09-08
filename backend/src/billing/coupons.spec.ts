import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingService } from './billing.service';
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
import { CouponRedemption, CouponRedemptionDocument, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponDocument, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageDocument, CreditPackageSchema } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { PaymentMethod, PaymentMethodDocument, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { WalletService } from './wallet.service';

// Real-Mongo integration tests (this project's established live-testing
// convention) for Phase 3: CouponsService's validation edge cases, plus
// end-to-end wiring through both places a coupon can actually be redeemed
// (BillingService.initiatePurchase for credit packages,
// BillingSubscriptionsService.checkout for plan subscriptions).

const TEST_PREFIX = `jest-billing-coupons-${Date.now()}`;

class FakePaymentProvider implements PaymentProviderAdapter {
  readonly providerKey = 'razorpay' as const;
  async createCustomer(): Promise<{ customerId: string }> {
    return { customerId: 'fake_cust' };
  }
  async createCheckoutOrder(): Promise<CreateCheckoutOrderResult> {
    return { orderId: `fake_order_${Date.now()}_${Math.random().toString(36).slice(2)}`, checkoutParams: {}, simulated: true };
  }
  async createAuthorizationOrder(): Promise<CreateCheckoutOrderResult> {
    return { orderId: `fake_auth_order_${Date.now()}_${Math.random().toString(36).slice(2)}`, checkoutParams: {}, simulated: true };
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

describe('Coupons (real Mongo)', () => {
  let connection: Connection;
  let coupons: CouponsService;
  let billingService: BillingService;
  let subscriptionsService: BillingSubscriptionsService;

  let couponModel: Model<CouponDocument>;
  let redemptionModel: Model<CouponRedemptionDocument>;
  let packageModel: Model<CreditPackageDocument>;
  let planModel: Model<BillingPlanDocument>;
  let priceModel: Model<BillingPlanPriceDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let walletModel: Model<WalletDocument>;
  let transactionModel: Model<WalletTransactionDocument>;
  let invoiceModel: Model<BillingInvoiceDocument>;

  const createdPackageIds: string[] = [];
  const createdPlanIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run coupon integration tests.');

    const configValues: Record<string, unknown> = {
      'billing.currency': 'INR',
      'billing.freeTrialCredits': 0,
      'billing.autoRechargeDefault': false,
      'billing.lowBalanceThresholdCredits': 200,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Coupon.name, schema: CouponSchema },
          { name: CouponRedemption.name, schema: CouponRedemptionSchema },
          { name: CreditPackage.name, schema: CreditPackageSchema },
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: BillingPlanPrice.name, schema: BillingPlanPriceSchema },
          { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
          { name: BillingSubscriptionEvent.name, schema: BillingSubscriptionEventSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: PaymentMethod.name, schema: PaymentMethodSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          // Phase 4 dependency of BillingService/BillingSubscriptionsService
          // — not exercised directly by these tests (see
          // billing-invoice.spec.ts for invoice-generation assertions), but
          // required for the module to compile.
          { name: BillingInvoice.name, schema: BillingInvoiceSchema },
          { name: BillingInvoiceCounter.name, schema: BillingInvoiceCounterSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
          { name: InvoiceTemplate.name, schema: InvoiceTemplateSchema },
        ]),
      ],
      providers: [
        CouponsService,
        BillingService,
        BillingSubscriptionsService,
        BillingInvoiceService,
        WalletService,
        { provide: PAYMENT_PROVIDER, useValue: new FakePaymentProvider() },
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Coupon.name)).db;
    coupons = moduleRef.get(CouponsService);
    billingService = moduleRef.get(BillingService);
    subscriptionsService = moduleRef.get(BillingSubscriptionsService);

    couponModel = moduleRef.get(getModelToken(Coupon.name));
    redemptionModel = moduleRef.get(getModelToken(CouponRedemption.name));
    packageModel = moduleRef.get(getModelToken(CreditPackage.name));
    planModel = moduleRef.get(getModelToken(BillingPlan.name));
    priceModel = moduleRef.get(getModelToken(BillingPlanPrice.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    invoiceModel = moduleRef.get(getModelToken(BillingInvoice.name));
  });

  afterAll(async () => {
    await couponModel.deleteMany({ code: { $regex: `^${TEST_PREFIX}` } });
    await redemptionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await packageModel.deleteMany({ _id: { $in: createdPackageIds } });
    await planModel.deleteMany({ _id: { $in: createdPlanIds } });
    await priceModel.deleteMany({ planId: { $in: createdPlanIds } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await invoiceModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  function couponCode(suffix: string): string {
    return `${TEST_PREFIX}-${suffix}`.toUpperCase();
  }

  describe('validate — discount math per type', () => {
    it('percentage: computes and caps correctly', async () => {
      const code = couponCode('pct20');
      await couponModel.create({ code, type: 'percentage', value: 20, appliesTo: 'all', maxRedemptionsPerOrg: 1 });

      const result = await coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-a`, context: 'credit_purchase', amount: 1000, currencyCode: 'INR' });
      expect(result.discountAmount).toBe(200);
      expect(result.bonusCredits).toBe(0);
    });

    it('fixed_amount: requires a matching currency and caps at the purchase amount', async () => {
      const code = couponCode('fixed2000');
      await couponModel.create({ code, type: 'fixed_amount', value: 2000, currencyCode: 'INR', appliesTo: 'all', maxRedemptionsPerOrg: 1 });

      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-b`, context: 'credit_purchase', amount: 1000, currencyCode: 'USD' }),
      ).rejects.toThrow();

      const result = await coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-b`, context: 'credit_purchase', amount: 1000, currencyCode: 'INR' });
      expect(result.discountAmount).toBe(1000); // capped at the purchase amount, not the full ₹2000
    });

    it('free_credits: grants bonus credits with zero price discount', async () => {
      const code = couponCode('bonus500');
      await couponModel.create({ code, type: 'free_credits', value: 500, appliesTo: 'all', maxRedemptionsPerOrg: 1 });

      const result = await coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-c`, context: 'credit_purchase', amount: 1000, currencyCode: 'INR' });
      expect(result.discountAmount).toBe(0);
      expect(result.bonusCredits).toBe(500);
    });
  });

  describe('validate — eligibility rejections', () => {
    it('rejects an unknown code', async () => {
      await expect(
        coupons.validate('DOES-NOT-EXIST', { organizationId: `${TEST_PREFIX}-org-d`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();
    });

    it('rejects an expired coupon', async () => {
      const code = couponCode('expired');
      await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'all', validTo: new Date(Date.now() - 86_400_000) });
      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-e`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();
    });

    it('rejects a not-yet-active coupon', async () => {
      const code = couponCode('future');
      await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'all', validFrom: new Date(Date.now() + 86_400_000) });
      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-f`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();
    });

    it('rejects a coupon used outside its appliesTo scope', async () => {
      const code = couponCode('packagesonly');
      await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'packages' });
      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-g`, context: 'subscription_checkout', planId: 'any-plan', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();
      // But is fine for the scope it's actually restricted to.
      const result = await coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-g`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' });
      expect(result.discountAmount).toBe(10);
    });

    it('rejects a coupon restricted to a different plan, allows the matching one', async () => {
      const code = couponCode('planrestricted');
      await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'plans', applicablePlanIds: ['allowed-plan-id'] });

      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-h`, context: 'subscription_checkout', planId: 'other-plan-id', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();

      const result = await coupons.validate(code, {
        organizationId: `${TEST_PREFIX}-org-h`,
        context: 'subscription_checkout',
        planId: 'allowed-plan-id',
        amount: 100,
        currencyCode: 'INR',
      });
      expect(result.discountAmount).toBe(10);
    });

    it('enforces maxRedemptions (total) and maxRedemptionsPerOrg independently', async () => {
      const code = couponCode('limited');
      const coupon = await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'all', maxRedemptions: 1, maxRedemptionsPerOrg: 1 });

      // Simulate one redemption having already happened for org-i.
      await redemptionModel.create({
        couponId: coupon._id.toString(),
        organizationId: `${TEST_PREFIX}-org-i`,
        redeemedBy: 'user-1',
        context: 'credit_purchase',
        paymentRecordId: `${TEST_PREFIX}-fake-payment-record-1`,
        amountDiscounted: 10,
      });

      // Same org — blocked by maxRedemptionsPerOrg.
      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-i`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();

      // Different org — blocked by the total maxRedemptions:1, already used up.
      await expect(
        coupons.validate(code, { organizationId: `${TEST_PREFIX}-org-j`, context: 'credit_purchase', amount: 100, currencyCode: 'INR' }),
      ).rejects.toThrow();
    });
  });

  describe('recordRedemption idempotency', () => {
    it('writes exactly one row even if called twice for the same PaymentRecord', async () => {
      const code = couponCode('idempotent');
      const coupon = await couponModel.create({ code, type: 'percentage', value: 10, appliesTo: 'all' });
      const record = await paymentRecordModel.create({
        organizationId: `${TEST_PREFIX}-org-k`,
        walletId: 'fake-wallet',
        type: 'purchase',
        provider: 'razorpay',
        couponId: coupon._id.toString(),
        couponDiscountAmount: 10,
        gatewayOrderId: `${TEST_PREFIX}-idempotent-order`,
        amount: 90,
        currency: 'INR',
        creditsGranted: 100,
        status: 'captured',
      });

      await coupons.recordRedemption(record, 'user-1', 'credit_purchase');
      await coupons.recordRedemption(record, 'user-1', 'credit_purchase');

      const rows = await redemptionModel.find({ couponId: coupon._id.toString() });
      expect(rows).toHaveLength(1);
    });
  });

  describe('end-to-end: credit package purchase with a coupon', () => {
    it('applies a free_credits coupon on top of a package purchase', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg`, name: 'Test Pack', credits: 1000, bonusCredits: 0, price: 999, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());
      const code = couponCode('pkgbonus');
      await couponModel.create({ code, type: 'free_credits', value: 500, appliesTo: 'all', maxRedemptionsPerOrg: 1 });

      const org = `${TEST_PREFIX}-org-purchase`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key, code);

      expect(result.simulated).toBe(true);
      expect(result.creditedImmediately).toBe(true);
      expect(result.wallet?.balanceCredits).toBe(1500); // 1000 base + 500 bonus

      const record = await paymentRecordModel.findOne({ _id: result.paymentRecordId });
      expect(record?.amount).toBe(999); // free_credits never discounts price
      expect(record?.creditsGranted).toBe(1500);

      const redemption = await redemptionModel.findOne({ paymentRecordId: result.paymentRecordId });
      expect(redemption?.bonusCredits).toBe(500);
    });
  });

  describe('end-to-end: subscription checkout with a coupon', () => {
    it('applies a percentage coupon to the checkout price, leaving creditsGranted unchanged', async () => {
      const plan = await planModel.create({ key: `${TEST_PREFIX}-plan-coupon`, name: 'Coupon Plan', active: true, isPublic: true, sortOrder: 0 });
      createdPlanIds.push(plan._id.toString());
      const price = await priceModel.create({
        planId: plan._id.toString(),
        currencyCode: 'INR',
        billingCycle: 'monthly',
        amount: 1000,
        creditsGranted: 5000,
        effectiveFrom: new Date(),
        effectiveTo: null,
        active: true,
      });
      const code = couponCode('sub20off');
      await couponModel.create({ code, type: 'percentage', value: 20, appliesTo: 'all', maxRedemptionsPerOrg: 1 });

      const org = `${TEST_PREFIX}-org-subscribe`;
      const result = await subscriptionsService.checkout(org, 'user-1', { planId: plan._id.toString(), priceId: price._id.toString(), couponCode: code });

      expect(result.subscription?.status).toBe('active');
      expect(result.subscription?.price?.creditsGranted).toBe(5000); // percentage doesn't add bonus credits

      const record = await paymentRecordModel.findOne({ _id: result.paymentRecordId });
      expect(record?.amount).toBe(800); // 1000 - 20%
      expect(record?.couponDiscountAmount).toBe(200);

      const wallet = await walletModel.findOne({ organizationId: org });
      expect(wallet?.balanceCredits).toBe(5000);

      const redemption = await redemptionModel.findOne({ paymentRecordId: result.paymentRecordId });
      expect(redemption?.amountDiscounted).toBe(200);
    });
  });
});
