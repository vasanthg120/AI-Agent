import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { buildDealMatchStage } from '../crm/deal-filter.util';
import { AnalyticsDashboardService } from './analytics-dashboard.service';

const PREFIX = `jest-pipeline-health-${Date.now()}`;

// Against a real Mongo: Pipeline Health for a period — the deals expected to
// close in the period's whole months, open ones split into on time / past due,
// counted in the database (no first-100 cap) and only for whoever may see them.
describe('Dashboard: pipeline health (real Mongo)', () => {
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
    // Only the deals are read for this figure.
    service = new AnalyticsDashboardService(dealModel, none, none, none, none, none, none, none, none, none);
  });

  afterAll(async () => {
    await connection.collection('crm_deals').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    const deal = (name: string, dealStatus: string, monetaryValue: number, expectedClosingDate: string, more: Record<string, unknown> = {}) => ({
      organizationId: org,
      name,
      dealStatus,
      monetaryValue,
      expectedClosingDate,
      ...more,
    });
    await connection.collection('crm_deals').insertMany([
      // May–Nov 2026, "today" = 2026-11-10.
      deal('Polos', 'open', 120000, '2026-07-18', { storeId: 'store-a', ownerId: 'u1' }),
      deal('Caps', 'open', 30000, '2026-11-09', { storeId: 'store-a', ownerId: 'u2' }),
      deal('Jackets', 'open', 45000, '2026-11-10', { storeId: 'store-b', ownerId: 'u1' }),
      deal('Uniforms', 'open', 264000, '2026-11-28', { storeId: 'store-b', ownerId: 'u2' }),
      deal('Aprons', 'won', 90000, '2026-06-15', { storeId: 'store-a', ownerId: 'u1' }),
      deal('Mugs', 'won', 10000, '2026-10-02', { storeId: 'store-b', ownerId: 'u2' }),
      deal('Bags', 'lost', 80000, '2026-09-20', { storeId: 'store-a', ownerId: 'u1' }),
      // Outside the period, and somebody else's.
      deal('April', 'open', 777, '2026-04-30'),
      deal('December', 'open', 888, '2026-12-01'),
      { ...deal('Theirs', 'open', 999999, '2026-08-05'), organizationId: `${org}-other` },
    ]);
  });

  const caller = () => ({ sub: 'u1', organizationId: org, roles: ['owner'], email: 'x' }) as never;

  it('open pipeline split into on time and past due, won, lost and win rate — for the period only', async () => {
    const health = await service.getPipelineHealth(caller(), { level: 'org' }, '2026-05-01', '2026-11-10', '2026-11-10');
    expect(health).toEqual({
      period: { first: '2026-05', last: '2026-11' },
      today: '2026-11-10',
      open: { count: 4, value: 459000 },
      // Closing today is not past due yet.
      onTime: { count: 2, value: 309000 },
      pastDue: { count: 2, value: 150000 },
      won: { count: 2, value: 100000 },
      lost: { count: 1, value: 80000 },
      winRatePct: 66.7,
    });
  });

  it('a store, or one person, sees only their own deals', async () => {
    const storeB = await service.getPipelineHealth(caller(), { level: 'store', storeId: 'store-b' }, '2026-05-01', '2026-11-10', '2026-11-10');
    expect(storeB).toMatchObject({ open: { count: 2, value: 309000 }, pastDue: { count: 0, value: 0 }, won: { count: 1, value: 10000 }, lost: { count: 0, value: 0 } });
    const u1 = await service.getPipelineHealth(caller(), { level: 'user', userId: 'u1' }, '2026-05-01', '2026-11-10', '2026-11-10');
    expect(u1).toMatchObject({ open: { count: 2, value: 165000 }, pastDue: { count: 1, value: 120000 }, winRatePct: 50 });
  });

  it('nothing closed yet: no win rate rather than 0%', async () => {
    const nov = await service.getPipelineHealth(caller(), { level: 'org' }, '2026-11-01', '2026-11-10', '2026-11-10');
    expect(nov).toMatchObject({ period: { first: '2026-11', last: '2026-11' }, open: { count: 3, value: 339000 }, winRatePct: null });
  });

  it('the past-due list filter picks exactly the deals counted as past due', async () => {
    const match = buildDealMatchStage(org, {
      dealStatus: ['open'],
      dateFrom: '2026-05-01',
      dateTo: '2026-11-10',
      dateField: 'expectedClosingDate',
      closingBefore: '2026-11-10',
    });
    const names = (await connection.collection('crm_deals').find(match as Record<string, unknown>).toArray()).map((d) => d.name).sort();
    expect(names).toEqual(['Caps', 'Polos']);
  });
});
