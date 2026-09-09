import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Product, ProductDocument, ProductSchema } from '../crm/schemas/product.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { QuoteCounter, QuoteCounterDocument, QuoteCounterSchema } from '../crm/schemas/quote-counter.schema';
import { QuotePayment, QuotePaymentDocument, QuotePaymentSchema } from '../crm/schemas/quote-payment.schema';
import { QuotePaymentsService } from '../crm/quote-payments.service';
import { QuotesService } from '../crm/quotes.service';
import { FinanceDocument, FinanceDocumentDocument, FinanceDocumentSchema } from '../finance/schemas/finance-document.schema';
import { Vendor, VendorDocument, VendorSchema } from '../vendors/schemas/vendor.schema';
import { VendorQuote, VendorQuoteDocument, VendorQuoteSchema } from '../vendors/schemas/vendor-quote.schema';
import { VendorProfitabilityService } from './vendor-profitability.service';

// Real-Mongo integration tests for the Vendor Quote <-> Customer Quote ->
// Vendor Profitability flow, using the exact worked example from the
// integration request: Customer Quote IN001 (₹10,000) linked to Vendor
// Quote INV011 (₹5,000) via a shared dealId. Follows quotes-create.spec.ts's
// established TEST_PREFIX convention.

const TEST_PREFIX = `jest-vendor-profitability-${Date.now()}`;

describe('Vendor Profitability — expected vs. actual vendor cost (real Mongo)', () => {
  let connection: Connection;
  let service: VendorProfitabilityService;
  let dealModel: Model<DealDocument>;
  let quoteModel: Model<QuoteDocument>;
  let financeModel: Model<FinanceDocumentDocument>;
  let vendorModel: Model<VendorDocument>;
  let vendorQuoteModel: Model<VendorQuoteDocument>;
  let productModel: Model<ProductDocument>;
  let counterModel: Model<QuoteCounterDocument>;
  let paymentModel: Model<QuotePaymentDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: Product.name, schema: ProductSchema },
          { name: Quote.name, schema: QuoteSchema },
          { name: QuoteCounter.name, schema: QuoteCounterSchema },
          { name: QuotePayment.name, schema: QuotePaymentSchema },
          { name: FinanceDocument.name, schema: FinanceDocumentSchema },
          { name: Vendor.name, schema: VendorSchema },
          { name: VendorQuote.name, schema: VendorQuoteSchema },
        ]),
      ],
      providers: [
        VendorProfitabilityService,
        QuotePaymentsService,
        QuotesService,
        { provide: HttpService, useValue: {} },
        { provide: JwtService, useValue: { sign: () => 'fake-token' } },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Quote.name)).db;
    service = moduleRef.get(VendorProfitabilityService);
    dealModel = moduleRef.get(getModelToken(Deal.name));
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    financeModel = moduleRef.get(getModelToken(FinanceDocument.name));
    vendorModel = moduleRef.get(getModelToken(Vendor.name));
    vendorQuoteModel = moduleRef.get(getModelToken(VendorQuote.name));
    productModel = moduleRef.get(getModelToken(Product.name));
    counterModel = moduleRef.get(getModelToken(QuoteCounter.name));
    paymentModel = moduleRef.get(getModelToken(QuotePayment.name));
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await financeModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await vendorModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await vendorQuoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await productModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await counterModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  // Range wide enough to comfortably bracket "now" for every test below.
  const start = new Date('2020-01-01');
  const end = new Date('2030-01-01');

  it('shows real Gross Profit/Margin/Markup even while the vendor payment is Pending — never ₹0 just because unpaid', async () => {
    const organizationId = `${TEST_PREFIX}-pending`;
    const deal = await dealModel.create({ organizationId, name: 'ABC Company deal', dealStatus: 'open' });
    await quoteModel.create({
      organizationId,
      dealId: deal._id.toString(),
      quoteNumber: 'IN001',
      quoteAmount: 10000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'ABC Company' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv011.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-1',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      vendorName: 'XYZ Supplier',
      invoiceNumber: 'INV011',
      paymentAmount: 5000,
      currency: 'INR',
      paymentStatus: 'pending',
      dueDate: '2026-09-15',
    });

    const overview = await service.getOverview(organizationId, start, end, {});
    expect(overview.rows).toHaveLength(1);
    const row = overview.rows[0];

    // The exact worked example: ₹10,000 - ₹5,000 = ₹5,000 profit, 50% margin, 100% markup.
    expect(row.customerRevenue).toBe(10000);
    expect(row.vendorCost).toBe(5000);
    expect(row.actualVendorCostPaid).toBe(0);
    expect(row.grossProfit).toBe(5000);
    expect(row.grossMarginPct).toBe(50);
    expect(row.markupPct).toBe(100);
    expect(row.vendorPaymentStatus).toBe('pending');
    expect(row.customerQuoteNo).toBe('IN001');
    expect(row.vendorQuoteNumbers).toEqual(['INV011']);

    expect(overview.totals.customerRevenue).toBe(10000);
    expect(overview.totals.vendorCost).toBe(5000);
    expect(overview.totals.actualVendorCostPaid).toBe(0);
    expect(overview.totals.grossProfit).toBe(5000);
    expect(overview.totals.grossMarginPct).toBe(50);
    expect(overview.totals.markupPct).toBe(100);
  });

  it('keeps profitability identical after the vendor payment is marked Paid — only actualVendorCostPaid changes', async () => {
    const organizationId = `${TEST_PREFIX}-paid`;
    const deal = await dealModel.create({ organizationId, name: 'ABC Company deal 2', dealStatus: 'open' });
    await quoteModel.create({
      organizationId,
      dealId: deal._id.toString(),
      quoteNumber: 'IN002',
      quoteAmount: 10000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'ABC Company' },
    });
    const doc = await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv012.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-2',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      vendorName: 'XYZ Supplier',
      invoiceNumber: 'INV012',
      paymentAmount: 5000,
      currency: 'INR',
      paymentStatus: 'pending',
    });

    const before = await service.getOverview(organizationId, start, end, {});
    expect(before.rows[0].vendorPaymentStatus).toBe('pending');
    expect(before.rows[0].actualVendorCostPaid).toBe(0);
    expect(before.rows[0].grossProfit).toBe(5000);

    await financeModel.updateOne({ _id: doc._id }, { $set: { paymentStatus: 'paid', paymentDate: '2026-09-10' } });

    const after = await service.getOverview(organizationId, start, end, {});
    expect(after.rows[0].vendorPaymentStatus).toBe('paid');
    expect(after.rows[0].actualVendorCostPaid).toBe(5000);
    // Gross Profit/Margin/Markup must be unaffected by the payment-status flip.
    expect(after.rows[0].grossProfit).toBe(5000);
    expect(after.rows[0].grossMarginPct).toBe(50);
    expect(after.rows[0].markupPct).toBe(100);
  });

  it('flags a currency mismatch and excludes it from aggregate totals, never silently converting', async () => {
    const organizationId = `${TEST_PREFIX}-mismatch`;
    const deal = await dealModel.create({ organizationId, name: 'Mismatched deal', dealStatus: 'open' });
    await quoteModel.create({
      organizationId,
      dealId: deal._id.toString(),
      quoteNumber: 'IN003',
      quoteAmount: 1000,
      currency: 'USD',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Currency Co' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv013.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-3',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      invoiceNumber: 'INV013',
      paymentAmount: 500,
      currency: 'INR',
      paymentStatus: 'pending',
    });

    const overview = await service.getOverview(organizationId, start, end, {});
    expect(overview.rows[0].currencyMismatch).toBe(true);
    expect(overview.rows[0].grossProfit).toBeNull();
    expect(overview.currencyMismatchCount).toBe(1);
    // Excluded from totals entirely — never fabricated by converting currencies.
    expect(overview.totals.customerRevenue).toBe(0);
    expect(overview.totals.vendorCost).toBe(0);
  });

  it('excludes cancelled vendor documents from cost but keeps other statuses', async () => {
    const organizationId = `${TEST_PREFIX}-cancelled`;
    const deal = await dealModel.create({ organizationId, name: 'Cancelled doc deal', dealStatus: 'open' });
    await quoteModel.create({
      organizationId,
      dealId: deal._id.toString(),
      quoteNumber: 'IN004',
      quoteAmount: 10000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Cancel Co' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv-cancelled.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-4',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      invoiceNumber: 'INV-CANCELLED',
      paymentAmount: 9999,
      currency: 'INR',
      paymentStatus: 'cancelled',
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv-real.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-5',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      invoiceNumber: 'INV014',
      paymentAmount: 3000,
      currency: 'INR',
      paymentStatus: 'overdue',
    });

    const overview = await service.getOverview(organizationId, start, end, {});
    expect(overview.rows[0].vendorCost).toBe(3000);
    expect(overview.rows[0].vendorQuoteNumbers).toEqual(['INV014']);
  });

  it('getDealDetail returns the complete bundle for one deal — documents, quotes, and PDF reference', async () => {
    const organizationId = `${TEST_PREFIX}-detail`;
    const deal = await dealModel.create({ organizationId, name: 'Detail Co deal', dealStatus: 'open' });
    await quoteModel.create({
      organizationId,
      dealId: deal._id.toString(),
      quoteNumber: 'IN005',
      quoteAmount: 10000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Detail Co' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv015.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'real-gridfs-id',
      documentFormat: 'pdf',
      dealId: deal._id.toString(),
      vendorName: 'XYZ Supplier',
      invoiceNumber: 'INV015',
      paymentAmount: 5000,
      currency: 'INR',
      paymentStatus: 'pending',
      aiSummary: 'Vendor invoice for 50 T-shirts',
    });

    const detail = await service.getDealDetail(organizationId, deal._id.toString());
    expect(detail.dealName).toBe('Detail Co deal');
    expect(detail.customerQuoteNo).toBe('IN005');
    expect(detail.grossProfit).toBe(5000);
    expect(detail.financeDocuments).toHaveLength(1);
    expect(detail.financeDocuments[0].gridFsFileId).toBe('real-gridfs-id');
    expect(detail.financeDocuments[0].aiSummary).toBe('Vendor invoice for 50 T-shirts');
    expect(detail.quotes).toHaveLength(1);
    expect(detail.quotes[0].customerName).toBe('Detail Co');
  });
});
