import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Product, ProductDocument, ProductSchema } from '../crm/schemas/product.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { QuoteCounter, QuoteCounterDocument, QuoteCounterSchema } from '../crm/schemas/quote-counter.schema';
import { QuotesService } from '../crm/quotes.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FinanceDocument, FinanceDocumentDocument, FinanceDocumentSchema } from './schemas/finance-document.schema';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceGridFsService } from './finance-gridfs.service';

// Real-Mongo integration tests for the Vendor Quote <-> Customer Quote
// linking flow (Finance AI's "Customer Quote No" field) — follows
// quotes-create.spec.ts's established TEST_PREFIX convention. Only the
// Quote/Deal/Product/QuoteCounter/FinanceDocument models are real; every
// other FinanceDocumentsService dependency (GridFS/HTTP/JWT/Config/Users/
// Notifications) is faked since searchCustomerQuotes/linkCustomerQuote never
// touch them.

const TEST_PREFIX = `jest-finance-quote-link-${Date.now()}`;

describe('Finance AI <-> Customer Quote linking (real Mongo)', () => {
  let connection: Connection;
  let financeDocumentsService: FinanceDocumentsService;
  let quotesService: QuotesService;
  let dealModel: Model<DealDocument>;
  let productModel: Model<ProductDocument>;
  let quoteModel: Model<QuoteDocument>;
  let counterModel: Model<QuoteCounterDocument>;
  let financeModel: Model<FinanceDocumentDocument>;

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
          { name: FinanceDocument.name, schema: FinanceDocumentSchema },
        ]),
      ],
      providers: [
        FinanceDocumentsService,
        QuotesService,
        { provide: FinanceGridFsService, useValue: {} },
        { provide: HttpService, useValue: {} },
        { provide: JwtService, useValue: { sign: () => 'fake-token' } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: UsersService, useValue: { findAll: async () => [] } },
        { provide: NotificationsService, useValue: { create: async () => undefined } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Quote.name)).db;
    financeDocumentsService = moduleRef.get(FinanceDocumentsService);
    quotesService = moduleRef.get(QuotesService);
    dealModel = moduleRef.get(getModelToken(Deal.name));
    productModel = moduleRef.get(getModelToken(Product.name));
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    counterModel = moduleRef.get(getModelToken(QuoteCounter.name));
    financeModel = moduleRef.get(getModelToken(FinanceDocument.name));
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await productModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await counterModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await financeModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  const createFinanceDoc = (organizationId: string, overrides: Partial<FinanceDocument> = {}) =>
    financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'inv011.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      gridFsFileId: `fake-file-${Math.random()}`,
      documentFormat: 'pdf',
      vendorName: 'XYZ Supplier',
      invoiceNumber: 'INV011',
      paymentAmount: 5000,
      currency: 'INR',
      paymentStatus: 'pending',
      ...overrides,
    });

  it('finds a customer quote by number (case-insensitive) and links it, populating dealId/customerQuoteNo', async () => {
    const organizationId = `${TEST_PREFIX}-link`;
    const quote = await quotesService.createQuote(
      organizationId,
      { clientDetails: { companyName: 'ABC Company', email: 'x@abc.test' }, items: [{ description: '50 T-shirts', quantity: 50, unitPrice: 200 }] },
      'user-1',
    );
    const deal = await dealModel.create({ organizationId, name: 'ABC Company deal', dealStatus: 'open' });
    await quoteModel.updateOne({ _id: quote._id }, { $set: { dealId: deal._id.toString() } });

    const doc = await createFinanceDoc(organizationId);

    const matches = await financeDocumentsService.searchCustomerQuotes(organizationId, quote.quoteNumber!.toLowerCase());
    expect(matches).toHaveLength(1);
    expect(matches[0].quoteId).toBe(quote._id.toString());
    expect(matches[0].customerName).toBe('ABC Company');
    expect(matches[0].quoteAmount).toBe(10000);

    const { document: linked, linkedQuote } = await financeDocumentsService.linkCustomerQuote(doc._id.toString(), organizationId, matches[0].quoteId);
    expect(linked.quoteId).toBe(quote._id.toString());
    expect(linked.dealId).toBe(deal._id.toString());
    expect(linked.customerQuoteNo).toBe(quote.quoteNumber);
    expect(linkedQuote.customerName).toBe('ABC Company');
  });

  it('returns no matches for a nonexistent quote number, without throwing', async () => {
    const organizationId = `${TEST_PREFIX}-notfound`;
    const matches = await financeDocumentsService.searchCustomerQuotes(organizationId, 'NOPE-999');
    expect(matches).toEqual([]);
  });

  it('never links a quote belonging to a different organization', async () => {
    const orgA = `${TEST_PREFIX}-orgA`;
    const orgB = `${TEST_PREFIX}-orgB`;
    const quoteA = await quotesService.createQuote(orgA, { clientDetails: { companyName: 'Org A Co' }, items: [{ description: 'X', quantity: 1, unitPrice: 100 }] }, 'user-1');
    const docB = await createFinanceDoc(orgB);

    await expect(financeDocumentsService.linkCustomerQuote(docB._id.toString(), orgB, quoteA._id.toString())).rejects.toThrow(NotFoundException);

    // Org isolation must also hold in the other direction — a document from
    // orgA can never be reached/linked using orgB's credentials either.
    const docA = await createFinanceDoc(orgA);
    await expect(financeDocumentsService.linkCustomerQuote(docA._id.toString(), orgB, quoteA._id.toString())).rejects.toThrow(NotFoundException);
  });

  it('supports relinking (correction) to a different customer quote', async () => {
    const organizationId = `${TEST_PREFIX}-relink`;
    const quote1 = await quotesService.createQuote(organizationId, { clientDetails: { companyName: 'First Co' }, items: [{ description: 'X', quantity: 1, unitPrice: 100 }] }, 'user-1');
    const quote2 = await quotesService.createQuote(organizationId, { clientDetails: { companyName: 'Second Co' }, items: [{ description: 'Y', quantity: 1, unitPrice: 200 }] }, 'user-1');
    const doc = await createFinanceDoc(organizationId);

    const { document: linked1 } = await financeDocumentsService.linkCustomerQuote(doc._id.toString(), organizationId, quote1._id.toString());
    expect(linked1.customerQuoteNo).toBe(quote1.quoteNumber);

    const { document: linked2 } = await financeDocumentsService.linkCustomerQuote(doc._id.toString(), organizationId, quote2._id.toString());
    expect(linked2.customerQuoteNo).toBe(quote2.quoteNumber);
    expect(linked2.quoteId).toBe(quote2._id.toString());
  });

  it('returns multiple matches when more than one quote shares a number, letting the caller pick', async () => {
    const organizationId = `${TEST_PREFIX}-multi`;
    // quoteNumber has no uniqueness constraint in the schema — two quotes can
    // legitimately share one (e.g. two different external CRM imports).
    const q1 = await quoteModel.create({ organizationId, quoteNumber: 'DUP-1', quoteAmount: 100, currency: 'INR', quoteStatus: 'draft', clientApprovalStatus: 'pending' });
    const q2 = await quoteModel.create({ organizationId, quoteNumber: 'DUP-1', quoteAmount: 200, currency: 'INR', quoteStatus: 'draft', clientApprovalStatus: 'pending' });

    const matches = await financeDocumentsService.searchCustomerQuotes(organizationId, 'DUP-1');
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.quoteId).sort()).toEqual([q1._id.toString(), q2._id.toString()].sort());
  });
});
