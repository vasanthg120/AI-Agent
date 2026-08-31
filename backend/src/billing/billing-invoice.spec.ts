import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import PDFDocument from 'pdfkit';
import { BillingAdminInvoicesService } from './billing-admin-invoices.service';
import { BillingAdminSettingsService } from './billing-admin-settings.service';
import { BillingAdminTemplatesService } from './billing-admin-templates.service';
import { BillingInvoicePdfService } from './billing-invoice-pdf.service';
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
import { BillingInvoiceCounter, BillingInvoiceCounterDocument, BillingInvoiceCounterSchema } from './schemas/billing-invoice-counter.schema';
import { BillingInvoice, BillingInvoiceDocument, BillingInvoiceSchema } from './schemas/billing-invoice.schema';
import { BillingPlan, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingSettings, BillingSettingsDocument, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { CouponRedemption, CouponRedemptionSchema } from './schemas/coupon-redemption.schema';
import { Coupon, CouponSchema } from './schemas/coupon.schema';
import { CreditPackage, CreditPackageDocument, CreditPackageSchema } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateDocument, InvoiceTemplateSchema } from './schemas/invoice-template.schema';
import { PaymentMethod, PaymentMethodSchema } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';
import { WalletService } from './wallet.service';

// Real-Mongo integration tests for Phase 4: invoice generation (triggered
// through BillingService.initiatePurchase, the same wiring a real purchase
// goes through — not called in isolation), numbering, org-scoping, the
// BillingSettings singleton, and the admin void/template/settings surfaces.
// BillingInvoiceCounter/BillingSettings are genuinely global singletons (see
// those schemas' own comments) shared with every other spec file that now
// triggers invoice generation as a side effect (billing-subscriptions.spec.ts,
// coupons.spec.ts) — so invoice number assertions here are relative
// (consecutive numbers differ by exactly 1), never an absolute "INV-1001".

const TEST_PREFIX = `jest-billing-invoice-${Date.now()}`;

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

describe('Invoices (real Mongo)', () => {
  let connection: Connection;
  let billingService: BillingService;
  let invoiceService: BillingInvoiceService;
  let pdfService: BillingInvoicePdfService;
  let adminInvoicesService: BillingAdminInvoicesService;
  let adminTemplatesService: BillingAdminTemplatesService;
  let adminSettingsService: BillingAdminSettingsService;

  let packageModel: Model<CreditPackageDocument>;
  let invoiceModel: Model<BillingInvoiceDocument>;
  let counterModel: Model<BillingInvoiceCounterDocument>;
  let settingsModel: Model<BillingSettingsDocument>;
  let templateModel: Model<InvoiceTemplateDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;
  let walletModel: Model<WalletDocument>;
  let transactionModel: Model<WalletTransactionDocument>;

  const createdPackageIds: string[] = [];
  const createdTemplateIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run invoice integration tests.');

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
        ]),
      ],
      providers: [
        BillingService,
        CouponsService,
        BillingInvoiceService,
        BillingInvoicePdfService,
        BillingAdminInvoicesService,
        BillingAdminTemplatesService,
        BillingAdminSettingsService,
        WalletService,
        { provide: PAYMENT_PROVIDER, useValue: new FakePaymentProvider() },
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingInvoice.name)).db;
    billingService = moduleRef.get(BillingService);
    invoiceService = moduleRef.get(BillingInvoiceService);
    pdfService = moduleRef.get(BillingInvoicePdfService);
    adminInvoicesService = moduleRef.get(BillingAdminInvoicesService);
    adminTemplatesService = moduleRef.get(BillingAdminTemplatesService);
    adminSettingsService = moduleRef.get(BillingAdminSettingsService);

    packageModel = moduleRef.get(getModelToken(CreditPackage.name));
    invoiceModel = moduleRef.get(getModelToken(BillingInvoice.name));
    counterModel = moduleRef.get(getModelToken(BillingInvoiceCounter.name));
    settingsModel = moduleRef.get(getModelToken(BillingSettings.name));
    templateModel = moduleRef.get(getModelToken(InvoiceTemplate.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
  });

  afterAll(async () => {
    await packageModel.deleteMany({ _id: { $in: createdPackageIds } });
    await invoiceModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await templateModel.deleteMany({ _id: { $in: createdTemplateIds } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    // Deliberately NOT deleting counterModel/settingsModel rows — both are
    // true global singletons (see their schemas' own comments) shared
    // across every spec file that triggers invoice generation; resetting
    // them here would corrupt other suites' invoice numbering.
    await connection.close();
  });

  describe('generateForPaymentRecord (via BillingService.initiatePurchase)', () => {
    it('creates exactly one invoice per purchase, with correct totals and a company snapshot', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg`, name: 'Test Pack', credits: 1000, bonusCredits: 0, price: 999, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());

      const org = `${TEST_PREFIX}-org-a`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);

      const invoice = await invoiceModel.findOne({ paymentRecordId: result.paymentRecordId });
      expect(invoice).toBeTruthy();
      expect(invoice?.organizationId).toBe(org);
      expect(invoice?.status).toBe('paid');
      expect(invoice?.currencyCode).toBe('INR');
      expect(invoice?.subtotal).toBe(999);
      expect(invoice?.total).toBe(999);
      expect(invoice?.discountAmount).toBe(0);
      expect(invoice?.items).toHaveLength(1);
      expect(invoice?.items[0].description).toContain('Test Pack');
      expect(invoice?.billingSnapshot.companyName).toBeTruthy();
      expect(invoice?.invoiceNumber).toMatch(/^[A-Z]+-\d+$/);
    });

    it('is idempotent — calling generateForPaymentRecord twice for the same PaymentRecord never issues a second invoice number', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-idem`, name: 'Idempotent Pack', credits: 500, bonusCredits: 0, price: 500, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());

      const org = `${TEST_PREFIX}-org-idem`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
      const record = await paymentRecordModel.findById(result.paymentRecordId);

      const first = await invoiceService.generateForPaymentRecord(record!);
      const second = await invoiceService.generateForPaymentRecord(record!);

      expect(second._id.toString()).toBe(first._id.toString());
      expect(second.invoiceNumber).toBe(first.invoiceNumber);
      const count = await invoiceModel.countDocuments({ paymentRecordId: result.paymentRecordId });
      expect(count).toBe(1);
    });

    it('numbers invoices sequentially (relative — the global counter is shared across spec files)', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-seq`, name: 'Seq Pack', credits: 100, bonusCredits: 0, price: 100, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());

      const orgA = `${TEST_PREFIX}-org-seq-a`;
      const orgB = `${TEST_PREFIX}-org-seq-b`;
      const resultA = await billingService.initiatePurchase(orgA, 'user-1', pkg.key);
      const resultB = await billingService.initiatePurchase(orgB, 'user-1', pkg.key);

      const invoiceA = await invoiceModel.findOne({ paymentRecordId: resultA.paymentRecordId });
      const invoiceB = await invoiceModel.findOne({ paymentRecordId: resultB.paymentRecordId });
      const numA = Number(invoiceA!.invoiceNumber.split('-').pop());
      const numB = Number(invoiceB!.invoiceNumber.split('-').pop());
      expect(numB).toBe(numA + 1);
    });
  });

  describe('customer read scoping', () => {
    it('getForOrganization 404s when the invoice belongs to a different organization', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-scope`, name: 'Scope Pack', credits: 100, bonusCredits: 0, price: 100, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());
      const org = `${TEST_PREFIX}-org-scope`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
      const invoice = await invoiceModel.findOne({ paymentRecordId: result.paymentRecordId });

      await expect(invoiceService.getForOrganization(`${TEST_PREFIX}-org-someone-else`, invoice!._id.toString())).rejects.toThrow();
      await expect(invoiceService.getForOrganization(org, invoice!._id.toString())).resolves.toBeTruthy();
    });
  });

  describe('BillingSettings singleton', () => {
    it('getOrCreateSettings never creates more than one document', async () => {
      const before = await settingsModel.countDocuments({ singletonKey: 'default' });
      await Promise.all(Array.from({ length: 5 }, () => invoiceService.getOrCreateSettings()));
      const after = await settingsModel.countDocuments({ singletonKey: 'default' });
      expect(after).toBe(Math.max(before, 1));
    });

    it('admin update persists and is reflected on the next invoice snapshot', async () => {
      await adminSettingsService.updateSettings({ companyName: `${TEST_PREFIX} Test Co`, invoiceFooterText: 'Thanks for your business!' });

      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-settings`, name: 'Settings Pack', credits: 100, bonusCredits: 0, price: 100, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());
      const org = `${TEST_PREFIX}-org-settings`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
      const invoice = await invoiceModel.findOne({ paymentRecordId: result.paymentRecordId });

      expect(invoice?.billingSnapshot.companyName).toBe(`${TEST_PREFIX} Test Co`);
      expect(invoice?.billingSnapshot.footerText).toBe('Thanks for your business!');
    });
  });

  describe('admin: void + templates', () => {
    it('voidInvoice marks status void with a reason and timestamp', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-void`, name: 'Void Pack', credits: 100, bonusCredits: 0, price: 100, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());
      const org = `${TEST_PREFIX}-org-void`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
      const invoice = await invoiceModel.findOne({ paymentRecordId: result.paymentRecordId });

      const voided = await adminInvoicesService.voidInvoice(invoice!._id.toString(), 'issued in error');
      expect(voided.status).toBe('void');
      expect(voided.voidReason).toBe('issued in error');
      expect(voided.voidedAt).toBeInstanceOf(Date);
    });

    it('only one template stays isDefault at a time', async () => {
      const t1 = await adminTemplatesService.createTemplate({ key: `${TEST_PREFIX}-tpl-1`, name: 'Template 1', isDefault: true });
      createdTemplateIds.push(t1._id.toString());
      const t2 = await adminTemplatesService.createTemplate({ key: `${TEST_PREFIX}-tpl-2`, name: 'Template 2', isDefault: true });
      createdTemplateIds.push(t2._id.toString());

      const refreshedT1 = await templateModel.findById(t1._id);
      const refreshedT2 = await templateModel.findById(t2._id);
      expect(refreshedT1?.isDefault).toBe(false);
      expect(refreshedT2?.isDefault).toBe(true);
    });
  });

  describe('BillingInvoicePdfService', () => {
    it('renders a non-empty PDF buffer without throwing', async () => {
      const pkg = await packageModel.create({ key: `${TEST_PREFIX}-pkg-pdf`, name: 'PDF Pack', credits: 100, bonusCredits: 0, price: 100, currency: 'INR', active: true });
      createdPackageIds.push(pkg._id.toString());
      const org = `${TEST_PREFIX}-org-pdf`;
      const result = await billingService.initiatePurchase(org, 'user-1', pkg.key);
      const invoice = await invoiceModel.findOne({ paymentRecordId: result.paymentRecordId });

      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

      pdfService.writePdf(doc, invoice!, null);
      doc.end();
      await done;

      const buffer = Buffer.concat(chunks);
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF'); // real PDF file signature
    });
  });
});
