import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { SalesTarget, SalesTargetDocument, SalesTargetSchema } from './schemas/sales-target.schema';
import { SalesAnalyticsService } from './sales-analytics.service';
import { countedMonths, expectedClosingMonthsMatch } from './deal-filter.util';

// The dashboard's date range counts every whole month it touches (2026-11-10:
// before, "1 May – 10 Nov" showed May's revenue and target only). Dates are in
// 2025, so every month is over and the projection is fixed whatever day this runs.

describe('countedMonths', () => {
  it('a range inside one month is that month', () => {
    expect(countedMonths('2026-11-01', '2026-11-10')).toEqual({ first: '2026-11', last: '2026-11', months: ['2026-11'] });
  });

  it('a range across months is every whole month it touches, across a year end too', () => {
    expect(countedMonths('2026-05-01', '2026-11-10').months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(countedMonths('2025-11-15', '2026-02-03').months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('an end before the start counts the start month only', () => {
    expect(countedMonths('2026-05-10', '2026-03-01').months).toEqual(['2026-05']);
  });

  it('matches one month by prefix and several by a text range of whole months', () => {
    expect(expectedClosingMonthsMatch('2026-11', '2026-11')).toEqual({ $regex: '^2026-11' });
    expect(expectedClosingMonthsMatch('2026-05', '2026-11')).toEqual({ $gte: '2026-05-01', $lte: '2026-11-31' });
  });
});

const TEST_PREFIX = `jest-sales-analytics-range-${Date.now()}`;

describe('SalesAnalyticsService.getAchievement over several months (real Mongo)', () => {
  let connection: Connection;
  let service: SalesAnalyticsService;
  let dealModel: Model<DealDocument>;
  let targetModel: Model<SalesTargetDocument>;
  const organizationId = `${TEST_PREFIX}-org`;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: SalesTarget.name, schema: SalesTargetSchema },
        ]),
      ],
      providers: [SalesAnalyticsService],
    }).compile();
    service = moduleRef.get(SalesAnalyticsService);
    dealModel = moduleRef.get(getModelToken(Deal.name));
    targetModel = moduleRef.get(getModelToken(SalesTarget.name));
    connection = dealModel.db;

    const deal = (name: string, dealStatus: string, expectedClosingDate: string, monetaryValue: number) =>
      ({ organizationId, name, dealStatus, expectedClosingDate, monetaryValue });
    await dealModel.insertMany([
      deal('Before the range', 'won', '2025-04-30', 99999),
      deal('May won', 'won', '2025-05-10', 1000),
      deal('Jun lost', 'lost', '2025-06-12', 500),
      deal('Jul won', 'won', '2025-07-02', 2000),
      deal('Aug open', 'open', '2025-08-20', 800),
      deal('Nov won, late in the month', 'won', '2025-11-28', 4000),
      deal('After the range', 'won', '2025-12-01', 88888),
    ]);
    const target = (storeId: string, period: string, targetAmount: number) =>
      ({ organizationId, scope: 'store', storeId, period, targetAmount, currency: 'INR' });
    await targetModel.insertMany([target('store-a', '2025-05', 5000), target('store-a', '2025-11', 3000), target('store-b', '2025-11', 2000)]);
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await targetModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('May–Nov: revenue of every month in the range, the sum of their targets, and the whole range as the projection', async () => {
    const a = await service.getAchievement(organizationId, 'org', undefined, '2025-05', '2025-11');
    expect(a).toMatchObject({
      period: '2025-05',
      lastPeriod: '2025-11',
      achieved: 7000,
      targetAmount: 10000,
      achievementPct: 70,
      remaining: 3000,
      // Every day of May–Nov 2025 is over: the projection is what was achieved.
      predictedMonthEnd: 7000,
      forecastConfidence: 1,
    });
  });

  it('one month is exactly the single-month figure, with or without lastPeriod', async () => {
    const withLast = await service.getAchievement(organizationId, 'org', undefined, '2025-11', '2025-11');
    const without = await service.getAchievement(organizationId, 'org', undefined, '2025-11');
    expect(withLast).toEqual(without);
    expect(without).toMatchObject({ period: '2025-11', lastPeriod: '2025-11', achieved: 4000, targetAmount: 5000, achievementPct: 80 });
  });

  it('months with no target leave the target empty rather than zero', async () => {
    const a = await service.getAchievement(organizationId, 'org', undefined, '2025-06', '2025-08');
    expect(a).toMatchObject({ achieved: 2000, targetAmount: null, achievementPct: null, remaining: null });
  });
});
