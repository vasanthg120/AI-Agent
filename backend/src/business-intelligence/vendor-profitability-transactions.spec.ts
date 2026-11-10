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

// Real-Mongo integration tests for the per-transaction Vendor Profitability
// view (getTransactions) — the direct regression coverage for "linking a
// vendor invoice to a customer quote with no Deal never showed up on the
// dashboard", since getOverview()/vendor-profitability.spec.ts only ever
// exercises the dealId-keyed path (every fixture there sets a matching
// dealId on both the Quote and the FinanceDocument).

const TEST_PREFIX = `jest-vendor-profitability-tx-${Date.now()}`;

describe('Vendor Profitability — per-transaction view (real Mongo)', () => {
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

  const start = new Date('2020-01-01');
  const end = new Date('2030-01-01');

  it('shows a quote-linked invoice with NO dealId — the exact reported bug', async () => {
    const organizationId = `${TEST_PREFIX}-nodeal`;
    const quote = await quoteModel.create({
      organizationId,
      quoteNumber: 'IN001',
      quoteAmount: 100000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'ABC Company' },
    });
    // No dealId anywhere — Quote.dealId is unset, FinanceDocument.dealId is
    // unset. Only quoteId links the two, exactly what linkCustomerQuote does
    // when the matched quote has no Deal.
    const doc = await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv011.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-tx-1',
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      vendorName: 'XYZ Supplier',
      invoiceNumber: 'INV011',
      invoiceDate: '2026-09-01',
      paymentAmount: 70000,
      currency: 'INR',
      paymentStatus: 'pending',
      quoteId: quote._id.toString(),
      customerQuoteNo: quote.quoteNumber,
    });

    const result = await service.getTransactions(organizationId, start, end, {});
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];

    // One row per customer quote: the row is the quote, its invoice is listed inside it.
    expect(row.transactionId).toBe(quote._id.toString());
    expect(row.invoices).toEqual([expect.objectContaining({ documentId: doc._id.toString(), vendorInvoiceAmount: 70000, included: true })]);
    expect(row.dealId).toBeUndefined();
    expect(row.customerName).toBe('ABC Company');
    expect(row.customerQuoteNo).toBe('IN001');
    expect(row.customerQuoteAmount).toBe(100000);
    expect(row.vendorName).toBe('XYZ Supplier');
    expect(row.vendorInvoiceNumber).toBe('INV011');
    expect(row.vendorInvoiceAmount).toBe(70000);
    // The worked example from the request: 100000 - 70000 = 30000, 30%.
    expect(row.profitAmount).toBe(30000);
    expect(row.profitMarginPct).toBe(30);
    expect(row.status).toBe('pending');

    expect(result.totals.customerQuoteAmount).toBe(100000);
    expect(result.totals.vendorInvoiceAmount).toBe(70000);
    expect(result.totals.profitAmount).toBe(30000);
    expect(result.totals.profitMarginPct).toBe(30);
  });

  it('prefers the linked master Vendor name over the raw extracted vendorName', async () => {
    const organizationId = `${TEST_PREFIX}-vendorref`;
    const vendor = await vendorModel.create({ organizationId, name: 'XYZ Supplier Pvt Ltd', status: 'active', createdBy: 'user-1' });
    const quote = await quoteModel.create({
      organizationId,
      quoteNumber: 'IN002',
      quoteAmount: 5000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Test Co' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv012.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-tx-2',
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      vendorName: 'xyz supplier (raw ocr text)',
      vendorRef: vendor._id.toString(),
      invoiceNumber: 'INV012',
      paymentAmount: 2000,
      currency: 'INR',
      paymentStatus: 'pending',
      quoteId: quote._id.toString(),
    });

    const result = await service.getTransactions(organizationId, start, end, {});
    expect(result.rows[0].vendorName).toBe('XYZ Supplier Pvt Ltd');
  });

  it('flags a currency mismatch, nulls profit for that row, and excludes it from totals', async () => {
    const organizationId = `${TEST_PREFIX}-mismatch`;
    const quote = await quoteModel.create({
      organizationId,
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
      gridFsFileId: 'fake-file-tx-3',
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      invoiceNumber: 'INV013',
      paymentAmount: 500,
      currency: 'INR',
      paymentStatus: 'pending',
      quoteId: quote._id.toString(),
    });

    const result = await service.getTransactions(organizationId, start, end, {});
    expect(result.rows[0].currencyMismatch).toBe(true);
    expect(result.rows[0].profitAmount).toBeNull();
    expect(result.rows[0].profitMarginPct).toBeNull();
    expect(result.currencyMismatchCount).toBe(1);
    expect(result.totals.customerQuoteAmount).toBe(0);
    expect(result.totals.vendorInvoiceAmount).toBe(0);
  });

  it('reflects a relink to a different customer quote — the corrected quote wins', async () => {
    const organizationId = `${TEST_PREFIX}-relink`;
    const quote1 = await quoteModel.create({
      organizationId,
      quoteNumber: 'IN004',
      quoteAmount: 8000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'First Co' },
    });
    const quote2 = await quoteModel.create({
      organizationId,
      quoteNumber: 'IN005',
      quoteAmount: 9000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Second Co' },
    });
    const doc = await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv014.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-tx-4',
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      invoiceNumber: 'INV014',
      paymentAmount: 4000,
      currency: 'INR',
      paymentStatus: 'pending',
      quoteId: quote1._id.toString(),
      customerQuoteNo: quote1.quoteNumber,
    });

    const before = await service.getTransactions(organizationId, start, end, {});
    expect(before.rows[0].customerQuoteNo).toBe('IN004');
    expect(before.rows[0].customerQuoteAmount).toBe(8000);

    await financeModel.updateOne({ _id: doc._id }, { $set: { quoteId: quote2._id.toString(), customerQuoteNo: quote2.quoteNumber } });

    const after = await service.getTransactions(organizationId, start, end, {});
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].customerQuoteNo).toBe('IN005');
    expect(after.rows[0].customerName).toBe('Second Co');
    expect(after.rows[0].customerQuoteAmount).toBe(9000);
    expect(after.rows[0].profitAmount).toBe(5000);
  });

  it('excludes cancelled vendor invoices', async () => {
    const organizationId = `${TEST_PREFIX}-cancelled`;
    const quote = await quoteModel.create({
      organizationId,
      quoteNumber: 'IN006',
      quoteAmount: 3000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Cancel Co' },
    });
    await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv015.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: 'fake-file-tx-5',
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      invoiceNumber: 'INV015',
      paymentAmount: 1000,
      currency: 'INR',
      paymentStatus: 'cancelled',
      quoteId: quote._id.toString(),
    });

    const result = await service.getTransactions(organizationId, start, end, {});
    expect(result.rows).toHaveLength(0);
  });

  // Mirrors a real quote (no. 118): two vendors' invoices for one customer
  // quote, one of them uploaded twice. Before 2026-11-06 this showed three
  // rows, each "quote − one invoice", and counted the quote three times.
  it('adds up every vendor invoice linked to one quote, counts the quote once, and skips a re-uploaded bill', async () => {
    const organizationId = `${TEST_PREFIX}-multi`;
    const quote = await quoteModel.create({
      organizationId,
      quoteNumber: '118',
      quoteAmount: 237707,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Multi Co' },
    });
    const other = await quoteModel.create({
      organizationId,
      quoteNumber: '98',
      quoteAmount: 20000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Other Co' },
    });
    const base = {
      organizationId,
      uploadedBy: 'user-1',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      currency: 'INR',
    };
    const hashtag = await financeModel.create({
      ...base,
      originalFilename: 'hashtag.pdf',
      gridFsFileId: 'fake-file-multi-1',
      vendorName: 'Hashtag Brands',
      invoiceNumber: 'PICHN2627013',
      invoiceDate: '2026-10-01',
      paymentAmount: 45006,
      taxAmount: 5635.8,
      paymentStatus: 'paid',
      quoteId: quote._id.toString(),
    });
    const brandwagon = await financeModel.create({
      ...base,
      originalFilename: 'brandwagon.pdf',
      gridFsFileId: 'fake-file-multi-2',
      vendorName: 'BRANDWAGON',
      invoiceNumber: 'PIBW2627305',
      invoiceDate: '2026-10-05',
      paymentAmount: 34751,
      taxAmount: 5301,
      paymentStatus: 'pending',
      quoteId: quote._id.toString(),
    });
    const reupload = await financeModel.create({
      ...base,
      originalFilename: 'brandwagon (1).pdf',
      gridFsFileId: 'fake-file-multi-3',
      vendorName: 'Brandwagon',
      invoiceNumber: 'PIBW-2627305',
      invoiceDate: '2026-10-05',
      paymentAmount: 34751,
      paymentStatus: 'pending',
      quoteId: quote._id.toString(),
    });
    await financeModel.create({
      ...base,
      originalFilename: 'other.pdf',
      gridFsFileId: 'fake-file-multi-4',
      vendorName: 'Young Creations',
      invoiceNumber: 'YC16127',
      paymentAmount: 11378,
      paymentStatus: 'paid',
      quoteId: other._id.toString(),
    });

    const result = await service.getTransactions(organizationId, start, end, {});
    expect(result.rows).toHaveLength(2);

    const row = result.rows.find((r) => r.transactionId === quote._id.toString())!;
    expect(row.invoices.map((i) => i.documentId)).toEqual([hashtag._id.toString(), brandwagon._id.toString(), reupload._id.toString()]);
    expect(row.invoices.map((i) => i.included)).toEqual([true, true, false]);
    expect(row.invoices[2].excludedReason).toBe('duplicate');
    expect(row.vendorInvoiceAmount).toBe(79757);
    expect(row.profitAmount).toBe(157950);
    expect(row.profitMarginPct).toBe(66.4);
    expect(row.vendorName).toBe('Hashtag Brands, BRANDWAGON');
    expect(row.invoiceDate).toBe('2026-10-05');
    expect(row.status).toBe('mixed');

    // Each quote once: 237,707 + 20,000; costs 79,757 + 11,378.
    expect(result.totals.customerQuoteAmount).toBe(257707);
    expect(result.totals.vendorInvoiceAmount).toBe(91135);
    expect(result.totals.profitAmount).toBe(166572);
    expect(result.totals.profitMarginPct).toBe(64.6);
  });

  it('lists a quote by any of its documents uploaded in the period, with the cost of all of them', async () => {
    const organizationId = `${TEST_PREFIX}-period`;
    const quote = await quoteModel.create({
      organizationId,
      quoteNumber: 'P-1',
      quoteAmount: 10000,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: 'Period Co' },
    });
    const base = {
      organizationId,
      uploadedBy: 'user-1',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      documentFormat: 'pdf',
      extractionStatus: 'completed',
      currency: 'INR',
      paymentStatus: 'paid',
      quoteId: quote._id.toString(),
    };
    const old = await financeModel.create({ ...base, originalFilename: 'old.pdf', gridFsFileId: 'fake-file-period-1', invoiceNumber: 'A1', paymentAmount: 3000 });
    await financeModel.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date('2025-01-15') } });
    await financeModel.create({ ...base, originalFilename: 'new.pdf', gridFsFileId: 'fake-file-period-2', invoiceNumber: 'A2', paymentAmount: 2000 });

    const thisYear = await service.getTransactions(organizationId, new Date('2026-01-01'), end, {});
    expect(thisYear.rows).toHaveLength(1);
    expect(thisYear.rows[0].vendorInvoiceAmount).toBe(5000);
    expect(thisYear.rows[0].profitAmount).toBe(5000);

    const beforeAnyUpload = await service.getTransactions(organizationId, new Date('2024-01-01'), new Date('2024-12-31'), {});
    expect(beforeAnyUpload.rows).toHaveLength(0);
  });
});
