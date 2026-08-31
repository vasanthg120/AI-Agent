import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { AutoPayService } from './autopay.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingService } from './billing.service';
import { CouponsService } from './coupons.service';
import { PricingService } from './pricing.service';
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
import { BillingInvoice, BillingInvoiceSchema } from './schemas/billing-invoice.schema';
import { BillingPlan, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingSettings, BillingSettingsDocument, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageSchema } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { PaymentMethod, PaymentMethodDocument, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { WalletService } from './wallet.service';

// Real-Mongo integration tests for the Auto Recharge correction: dynamic
// admin-floored/capped charge amount (replacing the old flat customer-chosen
// rechargeAmountCredits), the concurrency claim/lock, and
// BillingService.savePaymentMethod's dedupe/makeDefault + setDefaultPaymentMethod.

const TEST_PREFIX = `jest-autopay-${Date.now()}`;

class FakePaymentProvider implements PaymentProviderAdapter {
  readonly providerKey = 'razorpay' as const;
  chargeDelayMs = 0;
  chargeShouldSucceed = true;
  chargesAttempted = 0;

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
    this.chargesAttempted += 1;
    if (this.chargeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.chargeDelayMs));
    if (!this.chargeShouldSucceed) return { success: false, paymentId: '', simulated: true, reason: 'simulated decline' };
    return { success: true, paymentId: `fake_payment_${Date.now()}_${Math.random().toString(36).slice(2)}`, simulated: true };
  }
  async confirmPayment(): Promise<ConfirmPaymentResult> {
    return { success: true };
  }
  async refundPayment(): Promise<RefundResult> {
    return { success: true, gatewayRefundId: 'fake_refund', simulated: true };
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
  parseWebhookEvent(): GenericWebhookEvent {
    return { eventId: 'fake', event: 'payment.captured', raw: {} };
  }
}

describe('Auto Recharge correction (real Mongo)', () => {
  let connection: Connection;
  let autoPayService: AutoPayService;
  let billingService: BillingService;
  let fakeProvider: FakePaymentProvider;

  let walletModel: Model<WalletDocument>;
  let paymentMethodModel: Model<PaymentMethodDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let transactionModel: Model<WalletTransactionDocument>;
  let settingsModel: Model<BillingSettingsDocument>;
  let encryption: EncryptionService;

  const configValues: Record<string, unknown> = {
    'billing.currency': 'INR',
    'billing.usdToCurrencyRate': 83,
    'billing.creditValueInCurrency': 1,
    'billing.targetGrossMargin': 0.5,
    'billing.autoPayMaxConsecutiveFailures': 3,
    encryptionKey: 'test-encryption-key-for-autopay-spec',
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    fakeProvider = new FakePaymentProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Wallet.name, schema: WalletSchema },
          { name: PaymentMethod.name, schema: PaymentMethodSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
          { name: BillingInvoice.name, schema: BillingInvoiceSchema },
          { name: BillingInvoiceCounter.name, schema: BillingInvoiceCounterSchema },
          { name: CreditPackage.name, schema: CreditPackageSchema },
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: InvoiceTemplate.name, schema: InvoiceTemplateSchema },
          { name: Coupon.name, schema: CouponSchema },
          { name: CouponRedemption.name, schema: CouponRedemptionSchema },
        ]),
      ],
      providers: [
        AutoPayService,
        BillingService,
        WalletService,
        BillingInvoiceService,
        CouponsService,
        PricingService,
        EncryptionService,
        { provide: PAYMENT_PROVIDER, useValue: fakeProvider },
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Wallet.name)).db;
    autoPayService = moduleRef.get(AutoPayService);
    billingService = moduleRef.get(BillingService);

    walletModel = moduleRef.get(getModelToken(Wallet.name));
    paymentMethodModel = moduleRef.get(getModelToken(PaymentMethod.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    settingsModel = moduleRef.get(getModelToken(BillingSettings.name));
    encryption = moduleRef.get(EncryptionService);
  });

  afterEach(() => {
    fakeProvider.chargeDelayMs = 0;
    fakeProvider.chargeShouldSucceed = true;
    fakeProvider.chargesAttempted = 0;
  });

  afterAll(async () => {
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentMethodModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await settingsModel.deleteMany({ singletonKey: 'default' }); // the singleton this suite touches directly
    await connection.close();
  });

  /** A wallet + saved payment method ready for Auto Recharge, without going
   * through a real checkout — same "construct the fixture directly" style
   * refund.spec.ts uses for its uncaptured-payment test. */
  async function orgWithAutoPayReady(suffix: string) {
    const org = `${TEST_PREFIX}-org-${suffix}`;
    const method = await paymentMethodModel.create({
      organizationId: org,
      provider: 'razorpay',
      gatewayCustomerId: 'fake_cust',
      gatewayTokenIdEncrypted: encryption.encrypt('fake_gateway_token'),
      cardLast4: '4242',
      cardNetwork: 'visa',
      isDefault: true,
    });
    await walletModel.create({
      organizationId: org,
      balanceCredits: 0,
      reservedCredits: 0,
      autoPay: { enabled: true, thresholdCredits: 200, rechargeAmountCredits: 2000, paymentMethodId: method._id.toString(), consecutiveFailures: 0 },
    });
    return { org, method };
  }

  async function setAdminMinMax(minCredits?: number, maxCredits?: number) {
    await settingsModel.findOneAndUpdate(
      { singletonKey: 'default' },
      { $set: { autoRechargeMinCredits: minCredits, autoRechargeMaxCredits: maxCredits } },
      { upsert: true },
    );
  }

  describe('dynamic charge amount', () => {
    it('floors the charge at the admin minimum when required is below it', async () => {
      await setAdminMinMax(100, undefined);
      const { org } = await orgWithAutoPayReady('floor');

      const recharged = await autoPayService.attemptRecharge(org, 'test', 30);
      expect(recharged).toBe(true);

      const record = await paymentRecordModel.findOne({ organizationId: org, type: 'autopay' });
      expect(record?.creditsGranted).toBe(100); // floored, not the 30 "required" or any flat customer amount
    });

    it('charges the required amount when it exceeds the admin minimum', async () => {
      await setAdminMinMax(100, undefined);
      const { org } = await orgWithAutoPayReady('required-above-min');

      await autoPayService.attemptRecharge(org, 'test', 350);
      const record = await paymentRecordModel.findOne({ organizationId: org, type: 'autopay' });
      expect(record?.creditsGranted).toBe(350);
    });

    it('caps the charge at the admin maximum', async () => {
      await setAdminMinMax(100, 120);
      const { org } = await orgWithAutoPayReady('capped');

      await autoPayService.attemptRecharge(org, 'test', 500);
      const record = await paymentRecordModel.findOne({ organizationId: org, type: 'autopay' });
      expect(record?.creditsGranted).toBe(120);
    });

    it('never charges the flat wallet.autoPay.rechargeAmountCredits value once an admin minimum is configured', async () => {
      await setAdminMinMax(50, undefined);
      const { org } = await orgWithAutoPayReady('not-flat'); // wallet's own rechargeAmountCredits is 2000

      await autoPayService.attemptRecharge(org, 'test', 60);
      const record = await paymentRecordModel.findOne({ organizationId: org, type: 'autopay' });
      expect(record?.creditsGranted).toBe(60); // required (60) > admin min (50) — never the wallet's 2000
    });
  });

  describe('concurrency lock', () => {
    it('only ever creates one charge when two recharge attempts race on the same wallet', async () => {
      await setAdminMinMax(100, undefined);
      const { org } = await orgWithAutoPayReady('race');
      fakeProvider.chargeDelayMs = 150; // widen the race window past the DB round trips

      const [first, second] = await Promise.all([
        autoPayService.attemptRecharge(org, 'race-a', 100),
        autoPayService.attemptRecharge(org, 'race-b', 100),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1); // exactly one winner
      expect(fakeProvider.chargesAttempted).toBe(1); // the loser never reached the gateway at all

      const records = await paymentRecordModel.find({ organizationId: org, type: 'autopay' });
      expect(records).toHaveLength(1);
      const ledgerRows = await transactionModel.find({ organizationId: org, type: 'AUTO_RECHARGE' });
      expect(ledgerRows).toHaveLength(1);
    });

    it('releases the lock after completion so a later, sequential recharge still works', async () => {
      await setAdminMinMax(100, undefined);
      const { org } = await orgWithAutoPayReady('sequential');

      const first = await autoPayService.attemptRecharge(org, 'first', 100);
      expect(first).toBe(true);
      const second = await autoPayService.attemptRecharge(org, 'second', 100);
      expect(second).toBe(true);

      const records = await paymentRecordModel.find({ organizationId: org, type: 'autopay' });
      expect(records).toHaveLength(2);
    });
  });

  describe('BillingService.savePaymentMethod — dedupe + makeDefault', () => {
    it('reuses an existing row for the same card instead of creating a duplicate', async () => {
      const org = `${TEST_PREFIX}-org-dedupe`;
      const first = await billingService.savePaymentMethod(org, 'cust', 'pay_1', 'sig', 'order_1');
      const second = await billingService.savePaymentMethod(org, 'cust', 'pay_2', 'sig', 'order_2');

      expect(first._id.toString()).toBe(second._id.toString());
      const count = await paymentMethodModel.countDocuments({ organizationId: org });
      expect(count).toBe(1);
    });

    it('makeDefault forces a non-first card to become the new default, unsetting the previous one', async () => {
      const org = `${TEST_PREFIX}-org-makedefault`;

      // First card — becomes default because it's the org's first (isFirst),
      // not because of makeDefault.
      await paymentMethodModel.create({
        organizationId: org,
        provider: 'razorpay',
        gatewayCustomerId: 'cust_a',
        gatewayTokenIdEncrypted: 'enc_a',
        cardLast4: '1111',
        cardNetwork: 'visa',
        isDefault: true,
      });

      // A second, different card, saved with makeDefault:true (the
      // subscription-checkout path) — must become the new default even
      // though it isn't first.
      const second = await billingService.savePaymentMethod(org, 'cust_b', 'pay_b', 'sig', 'order_b', true);

      const firstCard = await paymentMethodModel.findOne({ organizationId: org, cardLast4: '1111' });
      expect(firstCard?.isDefault).toBe(false);
      expect(second.isDefault).toBe(true);

      const defaultCount = await paymentMethodModel.countDocuments({ organizationId: org, isDefault: true });
      expect(defaultCount).toBe(1);
    });
  });

  describe('BillingService.setDefaultPaymentMethod', () => {
    it('flips exactly one method to default and clears any other', async () => {
      const org = `${TEST_PREFIX}-org-setdefault`;
      const a = await paymentMethodModel.create({ organizationId: org, provider: 'razorpay', gatewayCustomerId: 'c', gatewayTokenIdEncrypted: 'e', cardLast4: '1111', cardNetwork: 'visa', isDefault: true });
      const b = await paymentMethodModel.create({ organizationId: org, provider: 'razorpay', gatewayCustomerId: 'c', gatewayTokenIdEncrypted: 'e', cardLast4: '2222', cardNetwork: 'mastercard', isDefault: false });

      const updated = await billingService.setDefaultPaymentMethod(org, b._id.toString());
      expect(updated.isDefault).toBe(true);

      const refreshedA = await paymentMethodModel.findById(a._id);
      expect(refreshedA?.isDefault).toBe(false);
      const defaultCount = await paymentMethodModel.countDocuments({ organizationId: org, isDefault: true });
      expect(defaultCount).toBe(1);
    });

    it('rejects a payment method id belonging to a different organization', async () => {
      const orgA = `${TEST_PREFIX}-org-cross-a`;
      const orgB = `${TEST_PREFIX}-org-cross-b`;
      const method = await paymentMethodModel.create({ organizationId: orgA, provider: 'razorpay', gatewayCustomerId: 'c', gatewayTokenIdEncrypted: 'e', cardLast4: '3333', cardNetwork: 'visa', isDefault: true });
      await expect(billingService.setDefaultPaymentMethod(orgB, method._id.toString())).rejects.toThrow();
    });
  });

  describe('getWalletSummary autoRechargePolicy', () => {
    it('surfaces the admin-configured min/max/defaultOn, never a customer-editable value', async () => {
      await setAdminMinMax(150, 400);
      await settingsModel.findOneAndUpdate({ singletonKey: 'default' }, { $set: { autoRechargeDefaultOn: true } });
      const { org } = await orgWithAutoPayReady('policy');

      const summary = await billingService.getWalletSummary(org);
      expect(summary.autoRechargePolicy).toEqual({ minCredits: 150, maxCredits: 400, defaultOn: true, currency: 'INR' });
    });
  });
});
