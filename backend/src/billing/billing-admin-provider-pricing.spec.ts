import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingAdminProviderPricingService } from './billing-admin-provider-pricing.service';
import { ProviderPricing, ProviderPricingDocument, ProviderPricingSchema } from './schemas/provider-pricing.schema';

// Real-Mongo integration tests for the admin ProviderPricing CRUD — the
// specific invariant that matters here is versioning: creating a new rate
// must never mutate a past row's cost/margin (that would silently rewrite
// how an already-settled transaction was priced), only close its
// effectiveTo so future settlements resolve to the new row.

const TEST_PREFIX = `jest-admin-provider-pricing-${Date.now()}`;

describe('BillingAdminProviderPricingService (real Mongo)', () => {
  let connection: Connection;
  let service: BillingAdminProviderPricingService;
  let pricingModel: Model<ProviderPricingDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: ProviderPricing.name, schema: ProviderPricingSchema }])],
      providers: [BillingAdminProviderPricingService],
    }).compile();

    connection = moduleRef.get(getModelToken(ProviderPricing.name)).db;
    service = moduleRef.get(BillingAdminProviderPricingService);
    pricingModel = moduleRef.get(getModelToken(ProviderPricing.name));
  });

  afterAll(async () => {
    await pricingModel.deleteMany({ provider: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates a new active row and leaves no prior row for a brand-new (provider, model)', async () => {
    const provider = `${TEST_PREFIX}-fresh`;
    const created = await service.create({ provider, model: 'v1', inputCostPerMTokUsd: 3, outputCostPerMTokUsd: 15 });
    expect(created.effectiveTo).toBeNull();
    expect(created.marginOverridePct).toBeUndefined();
  });

  it('a second create() for the same (provider, model) closes out the first row instead of deleting/editing it', async () => {
    const provider = `${TEST_PREFIX}-versioned`;
    const first = await service.create({ provider, model: 'v1', inputCostPerMTokUsd: 3, outputCostPerMTokUsd: 15 });
    expect(first.effectiveTo).toBeNull();

    const second = await service.create({ provider, model: 'v1', inputCostPerMTokUsd: 4, outputCostPerMTokUsd: 20, marginOverridePct: 60 });

    const reloadedFirst = await pricingModel.findById(first._id).exec();
    // The historical row is untouched except for its end-date — cost fields
    // preserved exactly as they were, so a past settlement's math is never
    // retroactively altered.
    expect(reloadedFirst!.inputCostPerMTokUsd).toBe(3);
    expect(reloadedFirst!.outputCostPerMTokUsd).toBe(15);
    expect(reloadedFirst!.effectiveTo).not.toBeNull();

    expect(second.effectiveTo).toBeNull();
    expect(second.marginOverridePct).toBe(60);
  });

  it('different models for the same provider are versioned independently', async () => {
    const provider = `${TEST_PREFIX}-multi-model`;
    await service.create({ provider, model: 'model-a', inputCostPerMTokUsd: 1, outputCostPerMTokUsd: 1 });
    await service.create({ provider, model: 'model-b', inputCostPerMTokUsd: 2, outputCostPerMTokUsd: 2 });

    const rows = await pricingModel.find({ provider, effectiveTo: null }).exec();
    expect(rows).toHaveLength(2);
  });

  it('list() returns every row, active and historical', async () => {
    const provider = `${TEST_PREFIX}-list`;
    await service.create({ provider, model: 'v1', inputCostPerMTokUsd: 1, outputCostPerMTokUsd: 1 });
    await service.create({ provider, model: 'v1', inputCostPerMTokUsd: 2, outputCostPerMTokUsd: 2 });

    const all = await service.list();
    const forProvider = all.filter((r) => r.provider === provider);
    expect(forProvider).toHaveLength(2);
  });
});
