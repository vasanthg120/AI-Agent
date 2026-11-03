import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { runWithDataSourceScope } from '../data-sources/data-source-context';
import { SalesAnalyticsService } from '../crm/sales-analytics.service';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { SalesTarget, SalesTargetDocument, SalesTargetSchema } from '../crm/schemas/sales-target.schema';
import { PreviousMonthClosuresService, previousPeriod } from './previous-month-closures.service';

const PREFIX = `jest-prev-closures-${Date.now()}`;
const COLLECTIONS = ['crm_deals', 'crm_quotes', 'crm_data_sources', 'crm_sync_runs'];

describe('previous month', () => {
  it('is the month before, across a year end', () => {
    expect(previousPeriod('2026-10')).toBe('2026-09');
    expect(previousPeriod('2027-01')).toBe('2026-12');
  });
});

// Against a real Mongo, shaped like the live ProspectConnect data: deals carry
// no creation date of their own (createdAt is when HaiVE first saw them, and
// the first import stamped every older deal at once), quotes carry the CRM's.
describe('Dashboard: deals from last month closed this month (real Mongo)', () => {
  let connection: Connection;
  let service: PreviousMonthClosuresService;
  let sales: SalesAnalyticsService;
  let seq = 0;
  let org: string;
  let crm: string;
  let native: string;

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
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    const dealModel = moduleRef.get<Model<DealDocument>>(getModelToken(Deal.name));
    service = new PreviousMonthClosuresService(dealModel, moduleRef.get<Model<QuoteDocument>>(getModelToken(Quote.name)), connection);
    sales = new SalesAnalyticsService(dealModel, moduleRef.get<Model<SalesTargetDocument>>(getModelToken(SalesTarget.name)));
  });

  afterAll(async () => {
    for (const name of COLLECTIONS) await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const IMPORT = new Date('2026-10-05T07:15:28Z');
  const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    const nativeId = new Types.ObjectId();
    const crmId = new Types.ObjectId();
    native = nativeId.toString();
    crm = crmId.toString();
    await connection.collection('crm_data_sources').insertMany([
      { _id: nativeId, organizationId: org, key: 'haive', provider: 'haive_native' },
      { _id: crmId, organizationId: org, key: 'prospectconnect', provider: 'prospectconnect', fieldMappings: { deals: { externalId: 'id' }, quotes: { createdAt: 'date_created' } } },
    ]);
    await connection.collection('crm_sync_runs').insertMany([
      // A run that failed before the first complete one is still part of the import.
      { organizationId: org, dataSourceId: crm, status: 'error', startedAt: new Date('2026-10-05T07:10:00Z'), finishedAt: new Date('2026-10-05T07:10:05Z') },
      { organizationId: org, dataSourceId: crm, status: 'ok', startedAt: new Date('2026-10-05T07:15:19Z'), finishedAt: new Date('2026-10-05T07:15:38Z') },
      { organizationId: org, dataSourceId: crm, status: 'ok', startedAt: new Date('2026-10-06T07:15:19Z'), finishedAt: new Date('2026-10-06T07:15:38Z') },
    ]);
  });

  type Seed = { name: string; status?: string; value: number; closing?: string; createdAt: Date; closedAt?: Date; source?: string; quotes?: Date[]; more?: Record<string, unknown> };
  const seed = async (rows: Seed[]) => {
    const deals = rows.map((r) => ({
      _id: new Types.ObjectId(),
      organizationId: org,
      dataSourceId: r.source ?? crm,
      name: r.name,
      dealStatus: r.status ?? 'won',
      monetaryValue: r.value,
      createdAt: r.createdAt,
      ...(r.closing ? { expectedClosingDate: r.closing } : {}),
      ...(r.closedAt ? { closedAt: r.closedAt } : {}),
      ...r.more,
    }));
    await connection.collection('crm_deals').insertMany(deals);
    const quotes = rows.flatMap((r, i) =>
      (r.quotes ?? []).map((createdAt) => ({ organizationId: org, dataSourceId: r.source ?? crm, dealId: deals[i]._id.toString(), quoteAmount: r.value, createdAt })),
    );
    if (quotes.length) await connection.collection('crm_quotes').insertMany(quotes);
  };

  it('lists won deals that started last month and closed this month, with the dates behind each', async () => {
    await seed([
      // Quoted 30 Sep, imported 5 Oct, closing date 31 Oct: started September, closed October.
      { name: 'REV Mech - Polo', value: 18898.95, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-09-30')] },
      // First seen after the import (a real creation date) — its September quote is still earlier.
      { name: 'Delta Decors', value: 7138.95, closing: '2026-10-31', createdAt: at('2026-10-20'), quotes: [at('2026-10-17'), at('2026-09-25')] },
      // Started this month: not from last month.
      { name: 'LAPIZ - Pens', value: 5900, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-10-01')] },
      // Started two months back: not last month either.
      { name: 'CKV Sarees', value: 68040, closing: '2026-10-12', createdAt: IMPORT, quotes: [at('2026-08-04')] },
      // Made in HaiVE in September, closed (recorded) on 3 Oct, but its closing date puts its revenue in September.
      { name: 'Blazers', value: 78223.95, closing: '2026-09-30', createdAt: at('2026-09-10'), closedAt: at('2026-10-03'), source: native },
      // Recorded as closed in September: not closed this month, even though its closing date is in October.
      { name: 'Kikon', value: 19897.5, closing: '2026-10-02', createdAt: at('2026-08-20'), closedAt: at('2026-09-28'), source: native },
      // Reopened, and lost: not won, so not here.
      { name: 'Reopened', status: 'open', value: 50000, closing: '2026-10-15', createdAt: IMPORT, quotes: [at('2026-09-12')] },
      { name: 'Lost', status: 'lost', value: 40000, closing: '2026-10-15', createdAt: IMPORT, quotes: [at('2026-09-12')] },
      // Somebody else's.
      { name: 'Theirs', value: 999999, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-09-30')], more: { organizationId: `${org}-other` } },
    ]);

    const result = await service.get(org, { level: 'org' }, '2026-10');
    expect(result).toEqual({
      period: '2026-10',
      previousPeriod: '2026-09',
      count: 3,
      value: 18898.95 + 7138.95 + 78223.95,
      inThisMonthRevenue: { count: 2, value: 18898.95 + 7138.95 },
      outsideThisMonthRevenue: { count: 1, value: 78223.95 },
      unknownStart: { count: 0, value: 0 },
      deals: [
        expect.objectContaining({ name: 'Blazers', startedOn: '2026-09-10', startedFrom: 'deal', closedOn: '2026-10-03', closedFrom: 'recorded', revenuePeriod: '2026-09' }),
        expect.objectContaining({ name: 'REV Mech - Polo', startedOn: '2026-09-30', startedFrom: 'quote', closedOn: '2026-10-31', closedFrom: 'closing-date', revenuePeriod: '2026-10' }),
        expect.objectContaining({ name: 'Delta Decors', startedOn: '2026-09-25', startedFrom: 'quote', closedOn: '2026-10-31', closedFrom: 'closing-date', revenuePeriod: '2026-10' }),
      ],
    });
  });

  it('never changes the revenue figure: it counts by closing date, this list only explains part of it', async () => {
    await seed([
      { name: 'REV Mech - Polo', value: 18898.95, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-09-30')] },
      { name: 'LAPIZ - Pens', value: 5900, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-10-01')] },
      { name: 'Blazers', value: 78223.95, closing: '2026-09-30', createdAt: at('2026-09-10'), closedAt: at('2026-10-03'), source: native },
    ]);
    const [october, september, listed] = await Promise.all([
      sales.getAchievement(org, 'org', undefined, '2026-10'),
      sales.getAchievement(org, 'org', undefined, '2026-09'),
      service.get(org, { level: 'org' }, '2026-10'),
    ]);
    expect(october.achieved).toBe(18898.95 + 5900);
    expect(september.achieved).toBe(78223.95);
    // Blazers closed in October but counts in September's revenue: listed as outside October's, never added to it.
    expect(listed.inThisMonthRevenue.value).toBe(18898.95);
    expect(listed.outsideThisMonthRevenue.value).toBe(78223.95);
  });

  it('a start it cannot know is reported as unknown, never guessed into a month', async () => {
    await seed([
      // Only the import stamp: it existed by 5 Oct, nobody knows since when.
      { name: 'No quote', value: 1000, closing: '2026-10-31', createdAt: IMPORT },
      // Its only quote is from 10 Oct, but the import proves the deal existed on 5 Oct — the start is earlier than any date we have.
      { name: 'Quoted later', value: 2000, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-10-10')] },
      // Inserted by the failed run before the first complete one: still the import.
      { name: 'Early run', value: 3000, closing: '2026-10-31', createdAt: new Date('2026-10-05T07:10:02Z') },
    ]);
    const result = await service.get(org, { level: 'org' }, '2026-10');
    expect(result.count).toBe(0);
    expect(result.unknownStart).toEqual({ count: 3, value: 6000 });
  });

  it('follows the selected month, across a year end', async () => {
    await seed([
      { name: 'December quote', value: 500, closing: '2027-01-08', createdAt: at('2026-12-02'), quotes: [at('2026-12-01')] },
      { name: 'November quote', value: 700, closing: '2027-01-09', createdAt: at('2026-12-02'), quotes: [at('2026-11-20')] },
    ]);
    const january = await service.get(org, { level: 'org' }, '2027-01');
    expect(january.previousPeriod).toBe('2026-12');
    expect(january.deals.map((d) => d.name)).toEqual(['December quote']);
    expect((await service.get(org, { level: 'org' }, '2026-12')).count).toBe(0);
  });

  it('a store or a person sees only their own deals', async () => {
    await seed([
      { name: 'Store A', value: 100, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-09-30')], more: { storeId: 'store-a', ownerId: 'u1' } },
      { name: 'Store B', value: 200, closing: '2026-10-31', createdAt: IMPORT, quotes: [at('2026-09-30')], more: { storeId: 'store-b', ownerId: 'u2' } },
    ]);
    expect((await service.get(org, { level: 'store', storeId: 'store-a' }, '2026-10')).deals.map((d) => d.name)).toEqual(['Store A']);
    expect((await service.get(org, { level: 'user', userId: 'u2' }, '2026-10')).deals.map((d) => d.name)).toEqual(['Store B']);
  });

  it('two CRMs viewed together: the same deal kept in both counts once, with the earliest start either knows', async () => {
    await seed([
      { name: 'Polos ', value: 9000, closing: '2026-10-20', createdAt: IMPORT, quotes: [at('2026-09-28')] },
      { name: 'polos', value: 9000, closing: '2026-10-20', createdAt: at('2026-09-14'), source: native },
    ]);
    const result = await runWithDataSourceScope({ organizationId: org, mode: 'unified', sourceIds: [crm, native], nativeSourceId: native }, () =>
      service.get(org, { level: 'org' }, '2026-10'),
    );
    expect(result.count).toBe(1);
    expect(result.deals[0]).toEqual(expect.objectContaining({ startedOn: '2026-09-14', value: 9000 }));
  });
});
