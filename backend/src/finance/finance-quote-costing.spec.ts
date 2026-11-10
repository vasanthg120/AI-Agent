import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { NotFoundException } from '@nestjs/common';
import { Connection, Model, Types } from 'mongoose';
import { of, throwError } from 'rxjs';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Product, ProductSchema } from '../crm/schemas/product.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { QuoteCounter, QuoteCounterSchema } from '../crm/schemas/quote-counter.schema';
import { QuotesService } from '../crm/quotes.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FinanceDocument, FinanceDocumentDocument, FinanceDocumentSchema } from './schemas/finance-document.schema';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceGridFsService } from './finance-gridfs.service';

// Real-Mongo integration tests for Finance AI quote costing: uploading
// several vendor documents straight into one customer quote, the quote's
// costing, unlinking, and the "not linked yet" list. GridFS and the
// python-agent extraction call are faked; what each upload "extracts" is
// queued per test in `extractions`.

const TEST_PREFIX = `jest-finance-quote-costing-${Date.now()}`;

describe('Finance AI quote costing (real Mongo)', () => {
  let connection: Connection;
  let service: FinanceDocumentsService;
  let quoteModel: Model<QuoteDocument>;
  let dealModel: Model<DealDocument>;
  let financeModel: Model<FinanceDocumentDocument>;
  const gridFsUploads: string[] = [];
  const extractions: (Record<string, unknown> | Error)[] = [];

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
        {
          provide: FinanceGridFsService,
          useValue: {
            upload: async (filename: string) => {
              gridFsUploads.push(filename);
              return `fake-gridfs-${gridFsUploads.length}`;
            },
          },
        },
        {
          provide: HttpService,
          useValue: {
            post: () => {
              const next = extractions.shift() ?? {};
              return next instanceof Error ? throwError(() => next) : of({ data: next });
            },
          },
        },
        { provide: JwtService, useValue: { sign: () => 'fake-token' } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: UsersService, useValue: { findAll: async () => [] } },
        { provide: NotificationsService, useValue: { create: async () => undefined } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Quote.name)).db;
    service = moduleRef.get(FinanceDocumentsService);
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    dealModel = moduleRef.get(getModelToken(Deal.name));
    financeModel = moduleRef.get(getModelToken(FinanceDocument.name));
  });

  afterAll(async () => {
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await financeModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  const file = (name: string) =>
    ({ originalname: name, mimetype: 'application/pdf', size: 1234, buffer: Buffer.from(`%PDF ${name}`) }) as Express.Multer.File;

  const createQuote = (organizationId: string, quoteNumber: string, quoteAmount: number, extra: Partial<Quote> = {}) =>
    quoteModel.create({
      organizationId,
      quoteNumber,
      quoteAmount,
      currency: 'INR',
      quoteStatus: 'sent',
      clientApprovalStatus: 'approved',
      clientDetails: { companyName: `${quoteNumber} Co` },
      ...extra,
    });

  it('uploads several vendor documents into one quote and works out what the quote earns', async () => {
    const organizationId = `${TEST_PREFIX}-costing`;
    const deal = await dealModel.create({ organizationId, name: 'Uniforms', dealStatus: 'open' });
    const quote = await createQuote(organizationId, '118', 237707, { dealId: deal._id.toString() });
    const quoteId = quote._id.toString();

    extractions.push(
      { vendorName: 'Hashtag Brands', invoiceNumber: 'PICHN2627013', paymentAmount: 45006, taxAmount: 5635.8, currency: 'INR', paymentStatus: 'paid' },
      { vendorName: 'BRANDWAGON', invoiceNumber: 'PIBW2627305', paymentAmount: 34751, taxAmount: 5301, currency: 'INR', paymentStatus: 'pending' },
      new Error('Request failed with status code 502'),
    );
    const first = await service.upload(organizationId, 'user-1', file('hashtag.pdf'), quoteId);
    const second = await service.upload(organizationId, 'user-1', file('brandwagon.pdf'), quoteId);
    const unreadable = await service.upload(organizationId, 'user-1', file('blurry-receipt.pdf'), quoteId);

    // Linked as it was stored, and the link survives the extraction's own fields being saved.
    for (const d of [first, second, unreadable]) {
      expect(d.quoteId).toBe(quoteId);
      expect(d.customerQuoteNo).toBe('118');
      expect(d.dealId).toBe(deal._id.toString());
    }
    expect(first.vendorName).toBe('Hashtag Brands');
    expect(unreadable.extractionStatus).toBe('failed');

    const costing = await service.getQuoteCosting(organizationId, quoteId);
    expect(costing.quote).toMatchObject({ quoteId, quoteNumber: '118', quoteAmount: 237707, customerName: '118 Co' });
    expect(costing.documents.map((d) => [d.document.originalFilename, d.included, d.excludedReason])).toEqual([
      ['hashtag.pdf', true, undefined],
      ['brandwagon.pdf', true, undefined],
      ['blurry-receipt.pdf', false, 'extraction_failed'],
    ]);
    expect(costing.totals).toMatchObject({ vendorCost: 79757, vendorTax: 10936.8, profit: 157950, marginPct: 66.4, markupPct: 198 });
  });

  it('checks the quote before storing anything: another business\'s quote is refused', async () => {
    const quoteOfB = await createQuote(`${TEST_PREFIX}-orgB`, 'B-1', 1000);
    const stored = gridFsUploads.length;

    await expect(service.upload(`${TEST_PREFIX}-orgA`, 'user-1', file('a.pdf'), quoteOfB._id.toString())).rejects.toThrow(NotFoundException);
    expect(gridFsUploads.length).toBe(stored);
    await expect(service.getQuoteCosting(`${TEST_PREFIX}-orgA`, quoteOfB._id.toString())).rejects.toThrow(NotFoundException);
  });

  it('answers "not found" for a quote id that is not an id at all', async () => {
    await expect(service.getQuoteCosting(`${TEST_PREFIX}-orgA`, 'not-an-id')).rejects.toThrow(NotFoundException);
    await expect(service.getQuoteCosting(`${TEST_PREFIX}-orgA`, new Types.ObjectId().toString())).rejects.toThrow(NotFoundException);
  });

  it('unlinks a document from its quote, which then no longer counts it', async () => {
    const organizationId = `${TEST_PREFIX}-unlink`;
    const deal = await dealModel.create({ organizationId, name: 'Caps', dealStatus: 'open' });
    const quote = await createQuote(organizationId, 'U-1', 5000, { dealId: deal._id.toString() });
    extractions.push({ vendorName: 'Cap Co', invoiceNumber: 'C1', paymentAmount: 2000, currency: 'INR' });
    const doc = await service.upload(organizationId, 'user-1', file('caps.pdf'), quote._id.toString());

    const unlinked = await service.unlinkCustomerQuote(doc._id.toString(), organizationId);
    expect(unlinked.quoteId).toBeUndefined();
    expect(unlinked.customerQuoteNo).toBeUndefined();
    expect(unlinked.dealId).toBeUndefined();

    const costing = await service.getQuoteCosting(organizationId, quote._id.toString());
    expect(costing.documents).toEqual([]);
    expect(costing.totals.profit).toBe(5000);

    await expect(service.unlinkCustomerQuote(doc._id.toString(), `${TEST_PREFIX}-someone-else`)).rejects.toThrow(NotFoundException);
  });

  it('relinking to a quote with no deal drops the previous quote\'s deal', async () => {
    const organizationId = `${TEST_PREFIX}-relink`;
    const deal = await dealModel.create({ organizationId, name: 'Old deal', dealStatus: 'open' });
    const withDeal = await createQuote(organizationId, 'R-1', 1000, { dealId: deal._id.toString() });
    const withoutDeal = await createQuote(organizationId, 'R-2', 2000);
    extractions.push({ vendorName: 'R Co', invoiceNumber: 'R1', paymentAmount: 100, currency: 'INR' });
    const doc = await service.upload(organizationId, 'user-1', file('r.pdf'), withDeal._id.toString());
    expect(doc.dealId).toBe(deal._id.toString());

    const { document: relinked } = await service.linkCustomerQuote(doc._id.toString(), organizationId, withoutDeal._id.toString());
    expect(relinked.quoteId).toBe(withoutDeal._id.toString());
    expect(relinked.dealId).toBeUndefined();
  });

  it('lists the documents not yet linked to any quote (and the linked ones)', async () => {
    const organizationId = `${TEST_PREFIX}-filter`;
    const quote = await createQuote(organizationId, 'F-1', 1000);
    extractions.push(
      { vendorName: 'Linked Co', invoiceNumber: 'L1', paymentAmount: 10, currency: 'INR' },
      { vendorName: 'Loose Co', invoiceNumber: 'L2', paymentAmount: 20, currency: 'INR' },
    );
    const linked = await service.upload(organizationId, 'user-1', file('linked.pdf'), quote._id.toString());
    const loose = await service.upload(organizationId, 'user-1', file('loose.pdf'));
    // A link cleared to null by older code counts as not linked too.
    const cleared = await financeModel.create({
      organizationId,
      uploadedBy: 'user-1',
      originalFilename: 'cleared.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 1,
      gridFsFileId: 'fake-cleared',
      documentFormat: 'pdf',
      quoteId: null as unknown as string,
    });

    const unlinked = await service.listFiltered(organizationId, { quoteLink: 'unlinked' });
    expect(unlinked.items.map((d) => d._id.toString()).sort()).toEqual([loose._id.toString(), cleared._id.toString()].sort());
    const linkedOnly = await service.listFiltered(organizationId, { quoteLink: 'linked' });
    expect(linkedOnly.items.map((d) => d._id.toString())).toEqual([linked._id.toString()]);
  });
});
