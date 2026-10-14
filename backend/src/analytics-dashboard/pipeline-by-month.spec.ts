import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { AnalyticsDashboardService, monthsBetween } from './analytics-dashboard.service';

const PREFIX = `jest-pipeline-${Date.now()}`;

describe('months of a pipeline', () => {
  it('every month from the first to the last, across a year end', () => {
    expect(monthsBetween('2026-04', '2026-04')).toEqual(['2026-04']);
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthsBetween('2026-06', '2026-04')).toEqual([]);
    // A year typed wrongly into a CRM never makes an endless list.
    expect(monthsBetween('2026-01', '2206-01')).toHaveLength(240);
  });
});

// Against a real Mongo: the open pipeline of every month at once — open deals
// only, by the month they are expected to close in, whoever asks seeing only
// what is theirs to see.
describe('Dashboard: overall pipeline, all months (real Mongo)', () => {
  let connection: Connection;
  let service: AnalyticsDashboardService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: Deal.name, schema: DealSchema }])],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    const dealModel = moduleRef.get<Model<DealDocument>>(getModelToken(Deal.name));
    const none = null as never;
    // Only the deals and the store names are read for this figure.
    service = new AnalyticsDashboardService(dealModel, none, none, none, none, none, none, none, {
      listStores: async () => [{ _id: 'store-a', name: 'T. Nagar' }],
    } as never);
  });

  afterAll(async () => {
    await connection.collection('crm_deals').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    const deal = (name: string, dealStatus: string, monetaryValue: number, expectedClosingDate?: string, more: Record<string, unknown> = {}) => ({
      organizationId: org,
      name,
      dealStatus,
      monetaryValue,
      ...(expectedClosingDate ? { expectedClosingDate } : {}),
      ...more,
    });
    await connection.collection('crm_deals').insertMany([
      deal('Polos', 'open', 120000, '2026-04-18', { storeId: 'store-a', ownerId: 'u1' }),
      deal('Caps', 'open', 30000, '2026-06-02', { storeId: 'store-a', ownerId: 'u2' }),
      deal('Jackets', 'open', 45000.5, '2026-06-30', { storeId: 'store-b', ownerId: 'u1' }),
      deal('Uniforms', 'open', 264000, '2026-09-10', { storeId: 'store-b', ownerId: 'u2' }),
      // Open, with nothing to say when: in the total, in no month.
      deal('Mugs', 'open', 5000, undefined, { storeId: 'store-a', ownerId: 'u1' }),
      deal('Hoodies', 'open', 7000, 'next month', { storeId: 'store-a' }),
      // Not pipeline: already won or lost.
      deal('Aprons', 'won', 900000, '2026-06-15', { storeId: 'store-a', ownerId: 'u1' }),
      deal('Bags', 'lost', 800000, '2026-09-20', { storeId: 'store-a', ownerId: 'u1' }),
      // Somebody else's.
      { ...deal('Theirs', 'open', 999999, '2026-05-05'), organizationId: `${org}-other` },
    ]);
  });

  const caller = () => ({ sub: 'u1', organizationId: org, roles: ['owner'], email: 'x' }) as never;

  it('every open deal, by the month it is expected to close — months in between included, at zero', async () => {
    const pipeline = await service.getPipelineByMonth(caller(), { level: 'org' });
    expect(pipeline).toEqual({
      scope: { level: 'org', storeId: undefined, storeName: undefined, userId: undefined },
      totalCount: 6,
      totalValue: 471000.5,
      months: [
        { period: '2026-04', count: 1, value: 120000 },
        { period: '2026-05', count: 0, value: 0 },
        { period: '2026-06', count: 2, value: 75000.5 },
        { period: '2026-07', count: 0, value: 0 },
        { period: '2026-08', count: 0, value: 0 },
        { period: '2026-09', count: 1, value: 264000 },
      ],
      undated: { count: 2, value: 12000 },
    });
    // The months and the undated deals add up to the total.
    expect(pipeline.months.reduce((sum, m) => sum + m.value, 0) + pipeline.undated.value).toBe(pipeline.totalValue);
  });

  it('a store’s pipeline, one person’s pipeline, and an organization with none', async () => {
    expect(await service.getPipelineByMonth(caller(), { level: 'store', storeId: 'store-a' })).toMatchObject({
      scope: { level: 'store', storeId: 'store-a', storeName: 'T. Nagar' },
      totalCount: 4,
      totalValue: 162000,
      months: [
        { period: '2026-04', count: 1, value: 120000 },
        { period: '2026-05', count: 0, value: 0 },
        { period: '2026-06', count: 1, value: 30000 },
      ],
      undated: { count: 2, value: 12000 },
    });
    expect(await service.getPipelineByMonth(caller(), { level: 'user', userId: 'u2' })).toMatchObject({
      totalCount: 2,
      totalValue: 294000,
      months: [
        { period: '2026-06', count: 1, value: 30000 },
        { period: '2026-07', count: 0, value: 0 },
        { period: '2026-08', count: 0, value: 0 },
        { period: '2026-09', count: 1, value: 264000 },
      ],
      undated: { count: 0, value: 0 },
    });
    expect(
      await service.getPipelineByMonth({ sub: 'x', organizationId: `${org}-nobody`, roles: ['owner'], email: 'x' } as never, { level: 'org' }),
    ).toMatchObject({
      totalCount: 0,
      totalValue: 0,
      months: [],
      undated: { count: 0, value: 0 },
    });
    // Another organization sees its own deal and nothing of ours.
    expect(
      await service.getPipelineByMonth({ sub: 'x', organizationId: `${org}-other`, roles: ['owner'], email: 'x' } as never, { level: 'org' }),
    ).toMatchObject({
      totalCount: 1,
      totalValue: 999999,
      months: [{ period: '2026-05', count: 1, value: 999999 }],
    });
  });
});
