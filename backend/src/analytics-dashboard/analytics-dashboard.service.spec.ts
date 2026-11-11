import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { AnalyticsDashboardService } from './analytics-dashboard.service';

// Real user-reported bug: picking a custom, multi-month "Advanced" date range
// on the dashboard (DashboardHeroHeader) left "Deals Won"/"Deals Lost"/
// "Open" stuck on whatever dateFrom's own calendar month showed, silently
// ignoring every other month inside the chosen range — because dealMatch
// filtered expectedClosingDate by a `${dateFrom-month}` regex prefix instead
// of the real [dateFrom, dateTo] span. Confirmed live: a "May 01 – Nov 06"
// range only ever reflected May. Fixed in analytics-dashboard.service.ts by
// matching expectedClosingDate with $gte/$lte against the real range.
//
// Constructs AnalyticsDashboardService directly (real Deal/Quote Mongoose
// models over a real connection, hand-rolled stubs for every other
// dependency) rather than importing the real AnalyticsDashboardModule —
// that module transitively pulls in CrmModule's full provider graph
// (external-service clients among them), which hangs module compilation in
// this environment. Same "stub cross-cutting services, keep only the models
// the fix actually touches real" convention customer-jobs.spec.ts already
// uses for the same reason.
describe('AnalyticsDashboardService.getOverview — custom date range', () => {
  const orgId = `jest-analytics-${Date.now()}`;
  const caller: JwtPayload = { sub: 'owner-1', email: 'owner@example.com', roles: ['owner'], organizationId: orgId };

  let service: AnalyticsDashboardService;
  let dealModel: Model<DealDocument>;
  let connection: Connection;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: Quote.name, schema: QuoteSchema },
        ]),
      ],
    }).compile();

    dealModel = moduleRef.get(getModelToken(Deal.name));
    const quoteModel = moduleRef.get<Model<QuoteDocument>>(getModelToken(Quote.name));
    connection = moduleRef.get(getConnectionToken());

    const emptyAchievement = {
      period: '',
      targetAmount: null,
      currency: 'INR',
      achieved: 0,
      achievementPct: 0,
      remaining: null,
      avgDailySalesNeeded: null,
      predictedMonthEnd: 0,
      forecastConfidence: 0,
    };
    const salesAnalyticsStub = { getAchievement: async () => emptyAchievement };
    const dealPerformanceDashboardStub = {
      getConsultantPerformance: async () => [],
      getRevenueProgress: async () => [],
    };
    const quotesStub = { getOutstandingByOwner: async () => new Map<string, number>() };
    const customerActivityStub = { getCustomerBreakdownForRange: async () => ({ newCount: 0, returningCount: 0 }) };
    const emailIntelligenceStub = { getActivityStats: async () => ({ newEnquiryCount: 0, missedCount: 0 }) };
    const dashboardStub = { getOverview: async () => ({ stats: { totalTasks: 0, overdueCount: 0 } }) };
    const organizationsStub = {};
    const previousMonthClosuresStub = { get: async () => ({ period: '', previousPeriod: '', deals: [] }) };

    service = new AnalyticsDashboardService(
      dealModel,
      quoteModel,
      salesAnalyticsStub as never,
      dealPerformanceDashboardStub as never,
      quotesStub as never,
      customerActivityStub as never,
      emailIntelligenceStub as never,
      dashboardStub as never,
      organizationsStub as never,
      previousMonthClosuresStub as never,
    );

    // One won deal in each of three non-adjacent months — a single-month
    // period filter would only ever see one of these at a time.
    await dealModel.create([
      { organizationId: orgId, name: 'May deal', dealStatus: 'won', monetaryValue: 1000, expectedClosingDate: '2026-05-15' },
      { organizationId: orgId, name: 'August deal', dealStatus: 'won', monetaryValue: 2000, expectedClosingDate: '2026-08-10' },
      { organizationId: orgId, name: 'November deal', dealStatus: 'won', monetaryValue: 4000, expectedClosingDate: '2026-11-01' },
      // Outside the range tested below on both ends — must never be counted.
      { organizationId: orgId, name: 'April deal (before range)', dealStatus: 'won', monetaryValue: 500, expectedClosingDate: '2026-04-30' },
      { organizationId: orgId, name: 'December deal (after range)', dealStatus: 'won', monetaryValue: 500, expectedClosingDate: '2026-12-01' },
    ]);
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: orgId });
    await connection.close();
  });

  it("a custom range spanning several months counts won deals from every month in it, not just dateFrom's month", async () => {
    const result = await service.getOverview(caller, { level: 'org' }, '2026-05-01', '2026-11-06');
    expect(result.deals.wonCount).toBe(3);
    expect(result.deals.wonValue).toBe(1000 + 2000 + 4000);
  });

  it('a range narrower than a full month still excludes deals outside it', async () => {
    const result = await service.getOverview(caller, { level: 'org' }, '2026-08-01', '2026-08-31');
    expect(result.deals.wonCount).toBe(1);
    expect(result.deals.wonValue).toBe(2000);
  });
});
