import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingService } from './billing.service';
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
import { CashfreePaymentProvider } from './providers/cashfree-payment.provider';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { RefundService } from './refund.service';
import { BillingInvoiceCounter, BillingInvoiceCounterSchema } from './schemas/billing-invoice-counter.schema';
import { BillingInvoice, BillingInvoiceDocument, BillingInvoiceSchema } from './schemas/billing-invoice.schema';
import { BillingPlan, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingSettings, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageDocument, CreditPackageSchema } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { PaymentMethod, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Refund, RefundDocument, RefundSchema } from './schemas/refund.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { WalletService } from './wallet.service';

// Real-Mongo integration tests for Phase 6: RefundService, exercised against
// real PaymentRecord/BillingInvoice rows produced by BillingService.initiatePurchase
// (same harness style as billing-invoice.spec.ts) so the whole
// purchase -> refund -> wallet-clawback -> invoice-void chain is covered
// end to end, not just RefundService in isolation.

const TEST_PREFIX = `jest-billing-refund-${Date.now()}`;

class FakePaymentProvider implements PaymentProviderAdapter {
  readonly providerKey = 'razorpay' as const;
  refundShouldSucceed = true;

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
    if (!this.refundShouldSucceed) return { success: false, simulated: true, reason: 'simulated decline' };
    return { success: true, gatewayRefundId: `fake_refund_${Date.now()}_${Math.random().toString(36).slice(2)}`, simulated: true };
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
  parseWebhookEvent(): GenericWebhookEvent {
    return { eventId: 'fake', event: 'payment.captured', raw: {} };
  }
}

describe('Refunds (real Mongo)', () => {
  let connection: Connection;
  let billingService: BillingService;
  let refundService: RefundService;
  let fakeProvider: FakePaymentProvider;

  let packageModel: Model<CreditPackageDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let refundModel: Model<RefundDocument>;
  let invoiceModel: Model<BillingInvoiceDocument>;
  let walletModel: Model<WalletDocument>;
  let transactionModel: Model<WalletTransactionDocument>;

  const createdPackageIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run refund integration tests.');

    fakeProvider = new FakePaymentProvider();
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
          { name: CreditPackage.name, schema: CreditPackageSchema },
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: PaymentMethod.name, schema: PaymentMethodSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: Coupon.name, schema: CouponSchema },
          { name: CouponRedemption.name, schema: CouponRedemptionSchema },
          { name: BillingInvoice.name, schema: BillingInvoiceSchema },
          { name: BillingInvoiceCounter.name, schema: BillingInvoiceCounterSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
          { name: InvoiceTemplate.name, schema: InvoiceTemplateSchema },
          { name: Refund.name, schema: RefundSchema },
        ]),
      ],
      providers: [
        BillingService,
        CouponsService,
        BillingInvoiceService,
        RefundService,
        WalletService,
        { provide: PAYMENT_PROVIDER, useValue: fakeProvider },
        // RefundService injects the three concrete provider classes
        // directly (same pattern as billing-webhook.controller.ts), not
        // just the active PAYMENT_PROVIDER token — bind all three to the
        // same fake since every PaymentRecord created below is 'razorpay'.
        { provide: RazorpayPaymentProvider, useValue: fakeProvider },
        { provide: StripePaymentProvider, useValue: fakeProvider },
        { provide: CashfreePaymentProvider, useValue: fakeProvider },
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(PaymentRecord.name)).db;
    billingService = moduleRef.get(BillingService);
    refundService = moduleRef.get(RefundService);

    packageModel = moduleRef.get(getModelToken(CreditPackage.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    refundModel = moduleRef.get(getModelToken(Refund.name));
    invoiceModel = moduleRef.get(getModelToken(BillingInvoice.name));
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
  });

  afterAll(async () => {
    await packageModel.deleteMany({ _id: { $in: createdPackageIds } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await refundModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await invoiceModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  async function purchase(orgSuffix: string, opts: { price?: number; credits?: number } = {}) {
    const pkg = await packageModel.create({
      key: `${TEST_PREFIX}-pkg-${orgSuffix}`,
      name: 'Refund Test Pack',
      credits: opts.credits ?? 1000,
      bonusCredits: 0,
      price: opts.price ?? 1000,
      currency: 'INR',
      active: true,
    });
    createdPackageIds.push(pkg._id.toString());
    const org = `${TEST_PREFIX}-org-${orgSuffix}`;
    const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
    const record = await paymentRecordModel.findById(result.paymentRecordId).exec();
    return { org, pkg, record: record! };
  }

  describe('full refund', () => {
    it('refunds the full amount, claws back all credits, and voids the linked invoice', async () => {
      fakeProvider.refundShouldSucceed = true;
      const { org, record } = await purchase('full');

      const walletBefore = await walletModel.findOne({ organizationId: org });
      expect(walletBefore?.balanceCredits).toBe(1000);

      const refund = await refundService.refundPayment(record._id.toString(), 'admin-1', { reason: 'customer request' });
      expect(refund.status).toBe('succeeded');
      expect(refund.creditsClawedBack).toBe(1000);

      const updatedRecord = await paymentRecordModel.findById(record._id);
      expect(updatedRecord?.status).toBe('refunded');
      expect(updatedRecord?.refundedAmount).toBe(1000);

      const walletAfter = await walletModel.findOne({ organizationId: org });
      expect(walletAfter?.balanceCredits).toBe(0);

      const refundTx = await transactionModel.findOne({ organizationId: org, type: 'REFUND' });
      expect(refundTx?.amountCredits).toBe(-1000);

      const invoice = await invoiceModel.findOne({ paymentRecordId: record._id.toString() });
      expect(invoice?.status).toBe('void');
      expect(invoice?.voidReason).toBe('Refunded');
    });
  });

  describe('partial refund', () => {
    it('claws back a proportional share of credits and leaves status partially_refunded + invoice paid', async () => {
      fakeProvider.refundShouldSucceed = true;
      const { org, record } = await purchase('partial', { price: 1000, credits: 1000 });

      const refund = await refundService.refundPayment(record._id.toString(), 'admin-1', { amount: 250 });
      expect(refund.creditsClawedBack).toBe(250); // 25% of 1000 credits

      const updatedRecord = await paymentRecordModel.findById(record._id);
      expect(updatedRecord?.status).toBe('partially_refunded');
      expect(updatedRecord?.refundedAmount).toBe(250);

      const wallet = await walletModel.findOne({ organizationId: org });
      expect(wallet?.balanceCredits).toBe(750);

      const invoice = await invoiceModel.findOne({ paymentRecordId: record._id.toString() });
      expect(invoice?.status).toBe('paid'); // untouched by a partial refund

      // A second partial refund covering the rest tips it over to fully refunded.
      const secondRefund = await refundService.refundPayment(record._id.toString(), 'admin-1', { amount: 750 });
      expect(secondRefund.creditsClawedBack).toBe(750);
      const finalRecord = await paymentRecordModel.findById(record._id);
      expect(finalRecord?.status).toBe('refunded');
      expect(finalRecord?.refundedAmount).toBe(1000);
      const finalInvoice = await invoiceModel.findOne({ paymentRecordId: record._id.toString() });
      expect(finalInvoice?.status).toBe('void');
    });
  });

  describe('rejections', () => {
    it('rejects a refund amount greater than what remains refundable', async () => {
      const { record } = await purchase('overrefund', { price: 500, credits: 500 });
      await expect(refundService.refundPayment(record._id.toString(), 'admin-1', { amount: 999 })).rejects.toThrow();
    });

    it('rejects refunding a payment that was never captured', async () => {
      const org = `${TEST_PREFIX}-org-uncaptured`;
      const record = await paymentRecordModel.create({
        organizationId: org,
        walletId: 'fake-wallet',
        type: 'purchase',
        provider: 'razorpay',
        gatewayOrderId: `${TEST_PREFIX}-uncaptured-order`,
        amount: 100,
        currency: 'INR',
        creditsGranted: 100,
        status: 'created',
      });
      await expect(refundService.refundPayment(record._id.toString(), 'admin-1', {})).rejects.toThrow();
    });
  });

  describe('failed refund attempt', () => {
    it('records a failed Refund row without touching the PaymentRecord or wallet', async () => {
      fakeProvider.refundShouldSucceed = false;
      const { org, record } = await purchase('declined', { price: 300, credits: 300 });

      const refund = await refundService.refundPayment(record._id.toString(), 'admin-1', {});
      expect(refund.status).toBe('failed');
      expect(refund.creditsClawedBack).toBe(0);

      const updatedRecord = await paymentRecordModel.findById(record._id);
      expect(updatedRecord?.status).toBe('captured'); // unchanged
      expect(updatedRecord?.refundedAmount).toBe(0);

      const wallet = await walletModel.findOne({ organizationId: org });
      expect(wallet?.balanceCredits).toBe(300); // untouched

      fakeProvider.refundShouldSucceed = true; // reset for subsequent tests
    });
  });

  describe('listRefunds', () => {
    it('filters by organizationId and paymentRecordId', async () => {
      fakeProvider.refundShouldSucceed = true;
      const { org, record } = await purchase('list', { price: 400, credits: 400 });
      await refundService.refundPayment(record._id.toString(), 'admin-1', {});

      const byOrg = await refundService.listRefunds({ organizationId: org });
      expect(byOrg).toHaveLength(1);

      const byPaymentRecord = await refundService.listRefunds({ paymentRecordId: record._id.toString() });
      expect(byPaymentRecord).toHaveLength(1);

      const byUnknownOrg = await refundService.listRefunds({ organizationId: `${TEST_PREFIX}-nonexistent` });
      expect(byUnknownOrg).toHaveLength(0);
    });
  });
});
