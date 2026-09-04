import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { Product, ProductDocument, ProductSchema } from './schemas/product.schema';
import { Quote, QuoteDocument, QuoteSchema } from './schemas/quote.schema';
import { QuoteCounter, QuoteCounterDocument, QuoteCounterSchema } from './schemas/quote-counter.schema';
import { QuotePayment, QuotePaymentDocument, QuotePaymentSchema } from './schemas/quote-payment.schema';
import { QuotesService } from './quotes.service';
import { QuotePaymentsService } from './quote-payments.service';
import { CreateQuoteDto } from './dto/create-quote.dto';

// Real-Mongo integration tests for native Quote creation/editing — the
// first CRM-domain spec file in this repo (see the Quotes in Pipeline V1
// plan). Follows email-sla.spec.ts's established TEST_PREFIX convention.

const TEST_PREFIX = `jest-quotes-create-${Date.now()}`;

describe('Quotes — native creation, pricing, and sync protection (real Mongo)', () => {
  let connection: Connection;
  let quotesService: QuotesService;
  let dealModel: Model<DealDocument>;
  let productModel: Model<ProductDocument>;
  let quoteModel: Model<QuoteDocument>;
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
        ]),
      ],
      providers: [QuotesService, QuotePaymentsService],
    }).compile();

    connection = moduleRef.get(getModelToken(Quote.name)).db;
    quotesService = moduleRef.get(QuotesService);
    dealModel = moduleRef.get(getModelToken(Deal.name));
    productModel = moduleRef.get(getModelToken(Product.name));
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    paymentModel = moduleRef.get(getModelToken(QuotePayment.name));
    await quoteModel.syncIndexes();
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await productModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  const baseDto = (items: CreateQuoteDto['items']): CreateQuoteDto => ({
    clientDetails: { companyName: 'Acme Corp', email: 'buyer@acme.test' },
    items,
  });

  it('creates a quote with a single line item and computes subtotal/discount/tax/total correctly', async () => {
    const organizationId = `${TEST_PREFIX}-single`;
    const dto = baseDto([{ description: 'Widget', quantity: 10, unitPrice: 100, discount: 50, taxRate: 18 }]);
    const quote = await quotesService.createQuote(organizationId, dto, 'user-1');

    // lineSubtotal = 10*100 = 1000; discounted = 950; tax = 950*0.18=171; lineTotal = 1121
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0].lineSubtotal).toBe(1000);
    expect(quote.items[0].lineTotal).toBe(1121);
    expect(quote.subtotal).toBe(1000);
    expect(quote.discountAmount).toBe(50);
    expect(quote.taxAmount).toBe(171);
    expect(quote.quoteAmount).toBe(1121);
    expect(quote.quoteNumber).toMatch(/^Q-\d{4}$/);
    expect(quote.currency).toBe('INR');
    expect(quote.quoteStatus).toBe('draft');
  });

  it('creates a quote with multiple line items and sums every line correctly', async () => {
    const organizationId = `${TEST_PREFIX}-multi`;
    const dto = baseDto([
      { description: 'Item A', quantity: 2, unitPrice: 50, discount: 0, taxRate: 10 },
      { description: 'Item B', quantity: 1, unitPrice: 200, discount: 20, taxRate: 5 },
    ]);
    const quote = await quotesService.createQuote(organizationId, dto, 'user-1');

    // A: subtotal 100, tax 10 -> total 110. B: subtotal 200, discounted 180, tax 9 -> total 189.
    expect(quote.subtotal).toBe(300);
    expect(quote.discountAmount).toBe(20);
    expect(quote.taxAmount).toBe(19);
    expect(quote.quoteAmount).toBe(299);
  });

  it('rejects invalid quantity, unit price, discount, and tax rate', async () => {
    const organizationId = `${TEST_PREFIX}-invalid`;
    await expect(quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 0, unitPrice: 10 }]), 'u')).rejects.toThrow(
      /quantity must be greater than zero/,
    );
    await expect(quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: -5 }]), 'u')).rejects.toThrow(
      /unit price cannot be negative/,
    );
    await expect(
      quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 10, discount: -1 }]), 'u'),
    ).rejects.toThrow(/discount cannot be negative/);
    await expect(
      quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 10, discount: 20 }]), 'u'),
    ).rejects.toThrow(/discount cannot exceed/);
    await expect(
      quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 10, taxRate: 150 }]), 'u'),
    ).rejects.toThrow(/tax rate must be between/);
  });

  it('generates sequential quote numbers reusing the existing per-org counter', async () => {
    const organizationId = `${TEST_PREFIX}-sequence`;
    const dto = baseDto([{ description: 'x', quantity: 1, unitPrice: 10 }]);
    const first = await quotesService.createQuote(organizationId, dto, 'u');
    const second = await quotesService.createQuote(organizationId, dto, 'u');
    const firstSeq = Number(first.quoteNumber!.split('-')[1]);
    const secondSeq = Number(second.quoteNumber!.split('-')[1]);
    expect(secondSeq).toBe(firstSeq + 1);
  });

  it('rejects a dealId that does not belong to this organization', async () => {
    const organizationId = `${TEST_PREFIX}-deal-org`;
    const otherOrgDeal = await dealModel.create({ organizationId: `${TEST_PREFIX}-deal-other`, name: 'Other org deal' });
    const dto = baseDto([{ description: 'x', quantity: 1, unitPrice: 10 }]);
    await expect(
      quotesService.createQuote(organizationId, { ...dto, dealId: otherOrgDeal._id.toString() }, 'u'),
    ).rejects.toThrow(/Deal not found/);
  });

  it('accepts a dealId that does belong to this organization', async () => {
    const organizationId = `${TEST_PREFIX}-deal-ok`;
    const deal = await dealModel.create({ organizationId, name: 'Real deal' });
    const dto = baseDto([{ description: 'x', quantity: 1, unitPrice: 10 }]);
    const quote = await quotesService.createQuote(organizationId, { ...dto, dealId: deal._id.toString() }, 'u');
    expect(quote.dealId).toBe(deal._id.toString());
  });

  it('rejects a productId that does not belong to this organization, and an inactive product', async () => {
    const organizationId = `${TEST_PREFIX}-product-org`;
    const otherOrgProduct = await productModel.create({ organizationId: `${TEST_PREFIX}-product-other`, name: 'Other', unitPrice: 5 });
    const inactiveProduct = await productModel.create({ organizationId, name: 'Retired', unitPrice: 5, isActive: false });

    await expect(
      quotesService.createQuote(
        organizationId,
        baseDto([{ productId: otherOrgProduct._id.toString(), description: 'x', quantity: 1, unitPrice: 5 }]),
        'u',
      ),
    ).rejects.toThrow(/not found in this organization/);

    await expect(
      quotesService.createQuote(
        organizationId,
        baseDto([{ productId: inactiveProduct._id.toString(), description: 'x', quantity: 1, unitPrice: 5 }]),
        'u',
      ),
    ).rejects.toThrow(/inactive product/);
  });

  it('updateQuote recalculates totals when items are edited', async () => {
    const organizationId = `${TEST_PREFIX}-edit`;
    const quote = await quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 100 }]), 'u');
    expect(quote.quoteAmount).toBe(100);

    const updated = await quotesService.updateQuote(organizationId, quote._id.toString(), {
      items: [{ description: 'x', quantity: 2, unitPrice: 100, discount: 0, taxRate: 0 }],
    });
    expect(updated.quoteAmount).toBe(200);
    expect(updated.subtotal).toBe(200);
  });

  it('SYNC_OWNED_FIELDS still blocks quoteAmount/clientApprovalStatus/quoteStatus/items on a synced quote, while a native quote stays fully editable', async () => {
    const organizationId = `${TEST_PREFIX}-sync`;
    const synced = await quoteModel.create({
      organizationId,
      externalId: 'ext-123',
      quoteStatus: 'draft',
      clientApprovalStatus: 'pending',
      quoteAmount: 500,
      currency: 'USD',
    });

    await expect(quotesService.updateQuote(organizationId, synced._id.toString(), { quoteAmount: 999 })).rejects.toThrow(/Cannot edit/);
    await expect(quotesService.updateQuote(organizationId, synced._id.toString(), { clientApprovalStatus: 'approved' })).rejects.toThrow(
      /Cannot edit/,
    );
    await expect(
      quotesService.updateQuote(organizationId, synced._id.toString(), {
        items: [{ description: 'x', quantity: 1, unitPrice: 1, discount: 0, taxRate: 0 }],
      }),
    ).rejects.toThrow(/Cannot edit/);

    // A non-sync-owned field (expirationDate) is still editable on a synced quote.
    const updated = await quotesService.updateQuote(organizationId, synced._id.toString(), { expirationDate: '2030-01-01' });
    expect(updated.expirationDate).toBe('2030-01-01');

    // A native quote (no externalId) is unaffected by any of this.
    const native = await quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 10 }]), 'u');
    const nativeUpdated = await quotesService.updateQuote(organizationId, native._id.toString(), { quoteAmount: 42, quoteStatus: 'sent' });
    expect(nativeUpdated.quoteAmount).toBe(42);
    expect(nativeUpdated.quoteStatus).toBe('sent');
  });

  it('org isolation: a quote created in one organization cannot be read or edited from another', async () => {
    const orgA = `${TEST_PREFIX}-iso-a`;
    const orgB = `${TEST_PREFIX}-iso-b`;
    const quote = await quotesService.createQuote(orgA, baseDto([{ description: 'x', quantity: 1, unitPrice: 10 }]), 'u');

    await expect(quotesService.getOne(orgB, quote._id.toString())).rejects.toThrow(/not found/i);
    await expect(quotesService.updateQuote(orgB, quote._id.toString(), { quoteName: 'hijacked' })).rejects.toThrow(/not found/i);
  });

  it('existing QuotePayment compatibility: a quote with payment records still loads paidAmount and history unaffected by the schema extension', async () => {
    const organizationId = `${TEST_PREFIX}-payments`;
    const quote = await quotesService.createQuote(organizationId, baseDto([{ description: 'x', quantity: 1, unitPrice: 1000 }]), 'u');

    const paymentsService = new QuotePaymentsService(quoteModel, paymentModel, quotesService);
    await paymentsService.recordPayment(organizationId, quote._id.toString(), { amount: 400, paymentDate: '2026-01-01' }, 'u');
    const afterPayment = await quotesService.getOne(organizationId, quote._id.toString());
    expect(afterPayment.paidAmount).toBe(400);

    const history = await paymentsService.listPayments(organizationId, quote._id.toString());
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe(400);
  });

  describe('product/quote currency consistency', () => {
    it('an INR product on an INR quote succeeds', async () => {
      const organizationId = `${TEST_PREFIX}-cur-inr-ok`;
      const product = await productModel.create({ organizationId, name: 'INR Widget', unitPrice: 100, currency: 'INR' });
      const quote = await quotesService.createQuote(
        organizationId,
        { ...baseDto([{ productId: product._id.toString(), description: 'INR Widget', quantity: 1, unitPrice: 100 }]), currency: 'INR' },
        'u',
      );
      expect(quote.currency).toBe('INR');
      expect(quote.quoteAmount).toBe(100);
    });

    it('a USD product on a USD quote succeeds', async () => {
      const organizationId = `${TEST_PREFIX}-cur-usd-ok`;
      const product = await productModel.create({ organizationId, name: 'USD Widget', unitPrice: 50, currency: 'USD' });
      const quote = await quotesService.createQuote(
        organizationId,
        { ...baseDto([{ productId: product._id.toString(), description: 'USD Widget', quantity: 2, unitPrice: 50 }]), currency: 'USD' },
        'u',
      );
      expect(quote.currency).toBe('USD');
      expect(quote.quoteAmount).toBe(100);
    });

    it('a USD product on an INR quote is rejected', async () => {
      const organizationId = `${TEST_PREFIX}-cur-mismatch`;
      const product = await productModel.create({ organizationId, name: 'USD Widget', unitPrice: 50, currency: 'USD' });
      await expect(
        quotesService.createQuote(
          organizationId,
          { ...baseDto([{ productId: product._id.toString(), description: 'USD Widget', quantity: 1, unitPrice: 50 }]), currency: 'INR' },
          'u',
        ),
      ).rejects.toThrow(/currency must match/i);
    });

    it('multiple products with mixed currencies are rejected', async () => {
      const organizationId = `${TEST_PREFIX}-cur-mixed`;
      const inrProduct = await productModel.create({ organizationId, name: 'INR Widget', unitPrice: 100, currency: 'INR' });
      const usdProduct = await productModel.create({ organizationId, name: 'USD Widget', unitPrice: 50, currency: 'USD' });
      await expect(
        quotesService.createQuote(
          organizationId,
          {
            ...baseDto([
              { productId: inrProduct._id.toString(), description: 'INR Widget', quantity: 1, unitPrice: 100 },
              { productId: usdProduct._id.toString(), description: 'USD Widget', quantity: 1, unitPrice: 50 },
            ]),
            currency: 'INR',
          },
          'u',
        ),
      ).rejects.toThrow(/currency must match/i);
    });

    it('updating a quote with a mismatched-currency product is rejected', async () => {
      const organizationId = `${TEST_PREFIX}-cur-update`;
      const inrProduct = await productModel.create({ organizationId, name: 'INR Widget', unitPrice: 100, currency: 'INR' });
      const usdProduct = await productModel.create({ organizationId, name: 'USD Widget', unitPrice: 50, currency: 'USD' });
      const quote = await quotesService.createQuote(
        organizationId,
        { ...baseDto([{ productId: inrProduct._id.toString(), description: 'INR Widget', quantity: 1, unitPrice: 100 }]), currency: 'INR' },
        'u',
      );

      await expect(
        quotesService.updateQuote(organizationId, quote._id.toString(), {
          items: [{ productId: usdProduct._id.toString(), description: 'USD Widget', quantity: 1, unitPrice: 50 }],
        }),
      ).rejects.toThrow(/currency must match/i);

      // Also rejected when the request changes the quote's own currency to
      // one that no longer matches an item already being submitted in the
      // same request.
      await expect(
        quotesService.updateQuote(organizationId, quote._id.toString(), {
          currency: 'USD',
          items: [{ productId: inrProduct._id.toString(), description: 'INR Widget', quantity: 1, unitPrice: 100 }],
        }),
      ).rejects.toThrow(/currency must match/i);
    });

    it('a cross-organization product reference is still rejected (not superseded by the currency check)', async () => {
      const organizationId = `${TEST_PREFIX}-cur-cross-org`;
      const otherOrgProduct = await productModel.create({ organizationId: `${TEST_PREFIX}-cur-cross-org-other`, name: 'Foreign', unitPrice: 10, currency: 'INR' });
      await expect(
        quotesService.createQuote(
          organizationId,
          { ...baseDto([{ productId: otherOrgProduct._id.toString(), description: 'Foreign', quantity: 1, unitPrice: 10 }]), currency: 'INR' },
          'u',
        ),
      ).rejects.toThrow(/not found in this organization/i);
    });
  });
});
