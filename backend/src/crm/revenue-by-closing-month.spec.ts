import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { AnalyticsDashboardService } from '../analytics-dashboard/analytics-dashboard.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { runWithDataSourceScope } from '../data-sources/data-source-context';
import { totalsOf, WonSalesService } from '../reporting/won-sales.service';
import { DealsService } from './deals.service';
import { countedDayOf } from './deal-filter.util';
import { SalesAnalyticsService } from './sales-analytics.service';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { Quote, QuoteDocument, QuoteSchema } from './schemas/quote.schema';
import { SalesTarget, SalesTargetSchema } from './schemas/sales-target.schema';

// Revenue counts a won deal in the month it was CLOSED (2026-11-25). Before,
// it went by the expected closing date, which a CRM keeps as a forecast: the
// real "Noble hospital - Uniforms" (expected 29 Jul, won 16 Nov) was July's
// revenue, and "vHire - Event" (won 24 Nov, no expected date) was in no month.
// The revenue figure, the overview's won/lost/open counts, the drill-down
// list behind them and Reporting must all hold the same deals. Dates are in
// 2025 so every month is over whatever day this runs.

const at = (iso: string) => new Date(iso);

describe('Revenue by the month a deal closed (real Mongo)', () => {
  const india = new Types.ObjectId().toString();
  const newYork = new Types.ObjectId().toString();
  const unified = new Types.ObjectId().toString();
  const caller = (organizationId: string): JwtPayload => ({ sub: 'owner-1', email: 'owner@example.com', roles: ['owner'], organizationId });

  let connection: Connection;
  let dealModel: Model<DealDocument>;
  let sales: SalesAnalyticsService;
  let overview: AnalyticsDashboardService;
  let deals: DealsService;
  let wonSales: WonSalesService;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: Quote.name, schema: QuoteSchema },
          { name: SalesTarget.name, schema: SalesTargetSchema },
        ]),
      ],
      providers: [SalesAnalyticsService],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    dealModel = moduleRef.get(getModelToken(Deal.name));
    sales = moduleRef.get(SalesAnalyticsService);
    deals = new DealsService(dealModel);
    wonSales = new WonSalesService(connection);
    overview = new AnalyticsDashboardService(
      dealModel,
      moduleRef.get<Model<QuoteDocument>>(getModelToken(Quote.name)),
      sales,
      { getConsultantPerformance: async () => [], getRevenueProgress: async () => [] } as never,
      { getOutstandingByOwner: async () => new Map<string, number>() } as never,
      { getCustomerBreakdownForRange: async () => ({ newCount: 0, returningCount: 0 }) } as never,
      { getActivityStats: async () => ({ newEnquiryCount: 0, missedCount: 0 }) } as never,
      { getOverview: async () => ({ stats: { totalTasks: 0, overdueCount: 0 } }) } as never,
      {} as never,
      { get: async () => null } as never,
    );

    // Own slugs: organizations.slug is unique once the Organization schema's indexes exist.
    await connection.collection('organizations').insertMany([
      { _id: new Types.ObjectId(india), name: 'jest revenue India', slug: `jest-revenue-${india}`, timezone: 'Asia/Kolkata' },
      { _id: new Types.ObjectId(newYork), name: 'jest revenue New York', slug: `jest-revenue-${newYork}`, timezone: 'America/New_York' },
    ]);
    const deal = (organizationId: string, name: string, dealStatus: string, monetaryValue: number, more: Record<string, unknown>) => ({
      organizationId,
      name,
      dealStatus,
      monetaryValue,
      createdAt: at('2025-11-02T09:40:46Z'),
      ...more,
    });
    await connection.collection('crm_deals').insertMany([
      // Created six months back, expected in July, won 16 Nov: November's.
      deal(india, 'Noble hospital', 'won', 291000, { createdAt: at('2025-05-02T06:00:00Z'), expectedClosingDate: '2025-07-29', closedAt: at('2025-11-16T07:44:05Z') }),
      // Created three months back, won 18 Nov.
      deal(india, 'Amazon jackets', 'won', 75000, { createdAt: at('2025-08-10T06:00:00Z'), expectedClosingDate: '2025-11-30', closedAt: at('2025-11-18T13:44:30Z') }),
      // Won with no expected closing date at all.
      deal(india, 'vHire event', 'won', 17000, { closedAt: at('2025-11-24T10:59:56Z') }),
      // Closed before closedAt was recorded: its closing date is all there is.
      deal(india, 'Old November sale', 'won', 1000, { expectedClosingDate: '2025-11-05' }),
      deal(india, 'Old July sale', 'won', 2000, { expectedClosingDate: '2025-07-15' }),
      // Never revenue.
      deal(india, 'Open in November', 'open', 3000, { expectedClosingDate: '2025-11-20' }),
      deal(india, 'Lost in November', 'lost', 4000, { expectedClosingDate: '2025-10-10', closedAt: at('2025-11-11T05:00:00Z') }),
      // Reopened, with a closedAt left behind: open again, so by its expected closing date (December).
      deal(india, 'Reopened', 'open', 6000, { expectedClosingDate: '2025-12-20', closedAt: at('2025-11-12T05:00:00Z') }),
      // 30 Nov 19:00 UTC is 1 Dec 00:30 in India: December's.
      deal(india, 'Just after midnight', 'won', 500, { expectedClosingDate: '2025-11-30', closedAt: at('2025-11-30T19:00:00Z') }),
      // 1 Dec 03:00 UTC is still 30 Nov in New York: November's.
      deal(newYork, 'New York late evening', 'won', 700, { expectedClosingDate: '2025-12-15', closedAt: at('2025-12-01T03:00:00Z') }),
    ]);
  });

  afterAll(async () => {
    await connection.collection('crm_deals').deleteMany({ organizationId: { $in: [india, newYork, unified] } });
    await connection.collection('organizations').deleteMany({ _id: { $in: [india, newYork].map((id) => new Types.ObjectId(id)) } });
    await connection.close();
  });

  it("counts a deal in the month it was won, however long before it was created or expected", async () => {
    const [july, november, december] = await Promise.all(['2025-07', '2025-11', '2025-12'].map((m) => sales.getAchievement(india, 'org', undefined, m)));
    expect(november.achieved).toBe(291000 + 75000 + 17000 + 1000);
    expect(july.achieved).toBe(2000);
    expect(december.achieved).toBe(500);
    // A range holds each sale once.
    expect((await sales.getAchievement(india, 'org', undefined, '2025-07', '2025-11')).achieved).toBe(2000 + 291000 + 75000 + 17000 + 1000);
  });

  it("goes by the business's own day", async () => {
    expect((await sales.getAchievement(newYork, 'org', undefined, '2025-11')).achieved).toBe(700);
    expect((await sales.getAchievement(newYork, 'org', undefined, '2025-12')).achieved).toBe(0);
    expect(countedDayOf({ dealStatus: 'won', closedAt: at('2025-11-30T19:00:00Z'), expectedClosingDate: '2025-11-30' }, 'Asia/Kolkata')).toBe('2025-12-01');
    expect(countedDayOf({ dealStatus: 'open', closedAt: at('2025-11-12T05:00:00Z'), expectedClosingDate: '2025-12-20' }, 'Asia/Kolkata')).toBe('2025-12-20');
  });

  it('the overview counts the same deals as revenue: won and lost by closing day, open by expected closing', async () => {
    const november = await overview.getOverview(caller(india), { level: 'org' }, '2025-11-01', '2025-11-30');
    expect(november.deals).toEqual({ wonCount: 4, wonValue: 384000, lostCount: 1, lostValue: 4000, openCount: 1, openValue: 3000 });
    expect(november.revenue.achieved).toBe(november.deals.wonValue);
    const july = await overview.getOverview(caller(india), { level: 'org' }, '2025-07-01', '2025-07-31');
    expect(july.deals.wonValue).toBe(2000);
    expect(july.revenue.achieved).toBe(2000);
  });

  it('the drill-down list behind the figure holds the same deals, each with the day it closed', async () => {
    const won = await deals.listFiltered(india, { dealStatus: ['won'], dateFrom: '2025-11-01', dateTo: '2025-11-25', dateField: 'expectedClosingDate', pageSize: 100 });
    expect(won.items.reduce((sum, d) => sum + d.monetaryValue, 0)).toBe(384000);
    const shown = await deals.withClosingDay(india, won.items);
    expect(Object.fromEntries(shown.map((d) => [d.name, (d as { closedOn?: string }).closedOn]))).toEqual({
      'Noble hospital': '2025-11-16',
      'Amazon jackets': '2025-11-18',
      'vHire event': '2025-11-24',
      'Old November sale': '2025-11-05',
    });
    const all = await deals.listFiltered(india, { dateFrom: '2025-11-01', dateTo: '2025-11-30', dateField: 'expectedClosingDate', pageSize: 100 });
    expect(all.items.map((d) => d.name).sort()).toEqual(['Amazon jackets', 'Lost in November', 'Noble hospital', 'Old November sale', 'Open in November', 'vHire event']);
  });

  it('Reporting sells the same deals, dated the day each closed', async () => {
    const sold = await wonSales.won(india, '2025-11-01', '2025-11-30');
    expect(totalsOf(sold).salesIncTax).toBe(384000);
    expect(sold.map((s) => [s.dealName, s.date])).toEqual([
      ['vHire event', '2025-11-24'],
      ['Amazon jackets', '2025-11-18'],
      ['Noble hospital', '2025-11-16'],
      ['Old November sale', '2025-11-05'],
    ]);
  });

  it('two CRMs read together count a deal kept in both once, and still count look-alike deals within one', async () => {
    const [first, second] = [new Types.ObjectId().toString(), new Types.ObjectId().toString()];
    const won = (dataSourceId: string, name: string, monetaryValue: number, closed: string) => ({
      organizationId: unified,
      dataSourceId,
      name,
      dealStatus: 'won',
      monetaryValue,
      expectedClosingDate: '2025-12-31',
      closedAt: at(closed),
    });
    await connection.collection('crm_deals').insertMany([
      won(first, 'Polos', 9000, '2025-11-10T06:00:00Z'),
      won(second, 'polos ', 9000, '2025-11-12T06:00:00Z'),
      won(first, 'T-shirt', 5000, '2025-11-03T06:00:00Z'),
      won(first, 'T-shirt', 5000, '2025-11-20T06:00:00Z'),
    ]);
    const scope = { organizationId: unified, mode: 'unified' as const, sourceIds: [first, second], nativeSourceId: first };
    const [revenue, counted] = await runWithDataSourceScope(scope, () =>
      Promise.all([
        sales.getAchievement(unified, 'org', undefined, '2025-11'),
        overview.getOverview(caller(unified), { level: 'org' }, '2025-11-01', '2025-11-30'),
      ]),
    );
    expect(revenue.achieved).toBe(9000 + 5000 + 5000);
    expect(counted.deals.wonCount).toBe(3);
    expect(counted.deals.wonValue).toBe(revenue.achieved);
    // One CRM at a time (the dashboards' normal view) adds nothing up twice either: each copy is in its own CRM.
    expect((await sales.getAchievement(unified, 'org', undefined, '2025-11')).achieved).toBe(28000);
  });
});
