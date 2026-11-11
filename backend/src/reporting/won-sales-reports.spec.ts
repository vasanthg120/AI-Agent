import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { runWithDataSourceScope } from '../data-sources/data-source-context';
import { RoyaltyReportExportService } from '../royalty/royalty-report-export.service';
import { RoyaltyReportService, royaltyOn } from '../royalty/royalty-report.service';
import { RoyaltyRulesService } from '../royalty/royalty-rules.service';
import { RoyaltyRule, RoyaltyRuleDocument, RoyaltyRuleSchema } from '../royalty/schemas/royalty-rule.schema';
import { GrossMarginReportService, marginOn } from './gross-margin-report.service';
import { ReportingSettingsService } from './reporting-settings.service';
import { SalesReportService } from './sales-report.service';
import { NO_CUSTOMER, totalsOf, wonSale, WonSalesService } from './won-sales.service';

const PREFIX = `jest-won-reports-${Date.now()}`;

// What a won deal is worth as a sale, and the arithmetic on top of it. No database.
describe('won deals as sales', () => {
  const deal = (over: Record<string, unknown> = {}) => ({ _id: 'd1', name: 'Polos order', monetaryValue: 118000, expectedClosingDate: '2026-09-20', ...over });
  const quote = (over: Record<string, unknown> = {}) => ({
    quoteNumber: 'Q-1',
    quoteAmount: 118000,
    taxes: [{ name: 'GST', amount: 18000 }],
    clientApprovalStatus: 'approved',
    createdAt: new Date('2026-09-10T06:00:00Z'),
    ...over,
  });

  it('the deal’s value is the sale, its tax in the same proportion as on its accepted quotation', () => {
    expect(wonSale(deal(), [quote({ clientDetails: { companyName: ' Sundar Textiles ' } })])).toMatchObject({
      id: 'd1',
      dealName: 'Polos order',
      quoteNumbers: 'Q-1',
      customer: 'Sundar Textiles',
      date: '2026-09-20',
      salesIncTax: 118000,
      tax: 18000,
      salesExTax: 100000,
      taxRecorded: true,
    });
    // The deal is worth less than the quote said (a discount at the end): same tax rate on what was won.
    expect(wonSale(deal({ monetaryValue: 59000 }), [quote()])).toMatchObject({ salesIncTax: 59000, tax: 9000, salesExTax: 50000 });
  });

  it('a re-issued copy of the quotation is never counted twice', () => {
    const copy = quote({ quoteNumber: 'Q-1b', createdAt: new Date('2026-09-12T06:00:00Z') });
    expect(wonSale(deal(), [quote(), copy])).toMatchObject({ salesIncTax: 118000, tax: 18000, salesExTax: 100000, quoteNumbers: 'Q-1b, Q-1' });
  });

  it('two genuine quotations for one deal: their tax together, against the deal’s value', () => {
    const a = quote({ quoteNumber: 'A', quoteAmount: 110000, taxes: [{ amount: 10000 }] });
    const b = quote({ quoteNumber: 'B', quoteAmount: 90000, taxes: [{ amount: 10000 }] });
    expect(wonSale(deal({ monetaryValue: 200000 }), [a, b])).toMatchObject({ tax: 20000, salesExTax: 180000 });
  });

  it('the accepted quotations decide the split; with none accepted, all of them do', () => {
    const accepted = quote({ quoteAmount: 1000, taxes: [{ amount: 100 }] });
    const pending = quote({ quoteAmount: 1000, taxes: [], clientApprovalStatus: 'awaiting_response' });
    expect(wonSale(deal({ monetaryValue: 1000 }), [accepted, pending])).toMatchObject({ tax: 100 });
    expect(wonSale(deal({ monetaryValue: 5000 }), [quote({ quoteAmount: 5000, taxes: [{ amount: 500 }], clientApprovalStatus: 'awaiting_response' })])).toMatchObject({ tax: 500 });
  });

  it('no quotation, or none with tax: nothing taken off, and it says so', () => {
    expect(wonSale(deal({ name: 'Mugs order' }), [])).toMatchObject({ customer: 'Mugs order', tax: 0, salesExTax: 118000, taxRecorded: false });
    expect(wonSale(deal({ name: '' }), []).customer).toBe(NO_CUSTOMER);
    expect(wonSale(deal(), [quote({ taxes: [] })])).toMatchObject({ tax: 0, taxRecorded: false });
    // A quotation written in HaiVE carries one tax amount instead of lines.
    expect(wonSale(deal(), [quote({ taxes: undefined, taxAmount: 18000 })])).toMatchObject({ tax: 18000, taxRecorded: true });
  });

  it('never more tax than the deal is worth, never a negative or garbage figure', () => {
    expect(wonSale(deal({ monetaryValue: 1000 }), [quote({ quoteAmount: 1000, taxes: [{ amount: 5000 }] })])).toMatchObject({ tax: 1000, salesExTax: 0 });
    expect(wonSale(deal({ monetaryValue: -50 }), [quote()])).toMatchObject({ salesIncTax: 0, tax: 0, salesExTax: 0 });
    expect(wonSale(deal({ monetaryValue: 'lots' }), [quote({ taxes: 'none' })])).toMatchObject({ salesIncTax: 0, tax: 0 });
  });

  it('totals add up to the paisa', () => {
    const sales = [
      wonSale(deal({ monetaryValue: 100.1 }), [quote({ quoteAmount: 100.1, taxes: [{ amount: 0.1 }] })]),
      wonSale(deal({ monetaryValue: 200.2 }), [quote({ quoteAmount: 200.2, taxes: [{ amount: 0.2 }] })]),
      wonSale(deal({ monetaryValue: 50 }), []),
    ];
    expect(totalsOf(sales)).toEqual({ deals: 3, withoutTax: 1, salesExTax: 350, tax: 0.3, salesIncTax: 350.3 });
  });

  it('gross margin is the set percentage of sales excluding tax — blank until one is set', () => {
    expect(marginOn(220000, 40)).toBe(88000);
    expect(marginOn(999.99, 33.33)).toBe(333.3);
    expect(marginOn(220000, 0)).toBe(0);
    expect(marginOn(220000, null)).toBeNull();
  });

  it('royalty: the rule’s rate, a floor or a ceiling, or one bracket of a sliding scale', () => {
    const rule = (over: Record<string, unknown> = {}) => ({ royaltyPercentage: 6, capType: 'none', slidingTiers: [], ...over }) as never;
    expect(royaltyOn(220000, null)).toEqual({ ratePct: 0, feeBeforeCap: 0, totalDue: 0 });
    expect(royaltyOn(220000, rule())).toEqual({ ratePct: 6, feeBeforeCap: 13200, totalDue: 13200 });
    expect(royaltyOn(220000, rule({ capType: 'max', capValue: 10000 }))).toMatchObject({ feeBeforeCap: 13200, totalDue: 10000 });
    expect(royaltyOn(220000, rule({ capType: 'min', capValue: 20000 }))).toMatchObject({ feeBeforeCap: 13200, totalDue: 20000 });
    const sliding = rule({
      capType: 'sliding',
      slidingTiers: [
        { fromValue: 0, toValue: 100000, percentage: 8 },
        { fromValue: 100000, percentage: 5 },
      ],
    });
    expect(royaltyOn(50000, sliding)).toEqual({ ratePct: 8, feeBeforeCap: 4000, totalDue: 4000 });
    expect(royaltyOn(220000, sliding)).toEqual({ ratePct: 5, feeBeforeCap: 11000, totalDue: 11000 });
  });
});

// Against a real Mongo: the three reports count the same thing — the deals won
// in the period, by the day each closed, at the deal's value (the Dashboard's
// revenue) — and nothing that was only quoted, lost, still open, or another
// organization's.
describe('Sales, Gross Margin and Royalty reports on won deals (real Mongo)', () => {
  let connection: Connection;
  let ruleModel: Model<RoyaltyRuleDocument>;
  let sales: SalesReportService;
  let margin: GrossMarginReportService;
  let settings: ReportingSettingsService;
  let royalty: RoyaltyReportService;
  let rules: RoyaltyRulesService;
  let seq = 0;
  let org: string;
  let owner: string;
  const dealIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: RoyaltyRule.name, schema: RoyaltyRuleSchema }])],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    ruleModel = moduleRef.get(getModelToken(RoyaltyRule.name));
  });

  afterAll(async () => {
    for (const name of ['crm_quotes', 'crm_deals', 'users', 'reporting_settings', 'royalty_rules', 'crm_data_sources']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const day = (d: string) => new Date(`${d}T06:30:00Z`);

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    dealIds.length = 0;
    const users = { findAll: async (organizationId: string) => connection.collection('users').find({ organizationId }).toArray() };
    const won = new WonSalesService(connection);
    sales = new SalesReportService(won, users as never);
    settings = new ReportingSettingsService(connection);
    margin = new GrossMarginReportService(won, sales, settings);
    rules = new RoyaltyRulesService(ruleModel);
    royalty = new RoyaltyReportService(won, sales, rules);

    owner = (
      await connection.collection('users').insertOne({ organizationId: org, name: 'Vasanth G', email: `${org}@example.test`, roles: ['owner'] })
    ).insertedId.toString();
    const deal = async (name: string, dealStatus: string, monetaryValue: number, expectedClosingDate: string, more: Record<string, unknown> = {}) => {
      const id = (await connection.collection('crm_deals').insertOne({ organizationId: org, name, dealStatus, monetaryValue, expectedClosingDate, ...more })).insertedId.toString();
      dealIds.push(id);
      return id;
    };
    const d1 = await deal('Sundar - polos', 'won', 105000, '2026-09-03', { ownerId: owner, storeId: 'store-a' });
    const d2 = await deal('Sundar - caps', 'won', 118000, '2026-09-20', { ownerId: owner, storeId: 'store-a' });
    const d3 = await deal('Kovai - caps', 'won', 20000, '2026-09-30', { storeId: 'store-b' });
    await deal('Mugs order', 'won', 30000, '2026-09-25', { storeId: 'store-a' });
    // Not won, or won in another month: left out of September.
    const open = await deal('Open - jackets', 'open', 50000, '2026-09-15', { storeId: 'store-a' });
    const lost = await deal('Lost - aprons', 'lost', 70000, '2026-09-12', { storeId: 'store-a' });
    const october = await deal('October - bags', 'won', 40000, '2026-10-01', { ownerId: owner, storeId: 'store-a' });
    await connection.collection('crm_deals').insertOne({ organizationId: `${org}-other`, name: 'Theirs', dealStatus: 'won', monetaryValue: 999999, expectedClosingDate: '2026-09-15' });

    const quote = (dealId: string, number: string, amount: number, created: string, more: Record<string, unknown> = {}) => ({
      organizationId: org,
      dealId,
      quoteNumber: number,
      quoteAmount: amount,
      quoteStatus: 'published',
      clientApprovalStatus: 'approved',
      createdAt: day(created),
      ...more,
    });
    await connection.collection('crm_quotes').insertMany([
      quote(d1, 'Q-1', 105000, '2026-08-28', { taxes: [{ name: 'GST', amount: 5000 }], clientDetails: { companyName: 'Sundar Textiles' }, ownerUserId: owner }),
      quote(d2, 'Q-2', 118000, '2026-09-05', { taxes: [{ name: 'GST', amount: 18000 }], clientDetails: { companyName: 'SUNDAR TEXTILES' }, ownerUserId: owner }),
      // The same quotation re-issued: counted once (the deal's value is the sale).
      quote(d2, 'Q-2b', 118000, '2026-09-06', { taxes: [{ name: 'GST', amount: 18000 }], clientDetails: { companyName: 'SUNDAR TEXTILES' }, ownerUserId: owner }),
      // A draft is never read, not even for the tax split.
      quote(d2, 'Q-3', 50000, '2026-09-07', { quoteStatus: 'draft', taxes: [{ name: 'GST', amount: 49000 }] }),
      // No tax line; its owner known only by the CRM's name for them.
      quote(d3, 'Q-4', 20000, '2026-09-29', { clientDetails: { companyName: 'Kovai Mills' }, quoteOwner: 'crm-77', quoteOwnerLabel: 'Sanjay Kumar' }),
      // Sent in September, but for deals not won in September: no sale in September.
      quote(open, 'Q-5', 50000, '2026-09-10', { taxes: [{ amount: 5000 }] }),
      quote(lost, 'Q-6', 70000, '2026-09-11', { taxes: [{ amount: 7000 }] }),
      quote(october, 'Q-7', 40000, '2026-09-25', { taxes: [{ amount: 4000 }] }),
    ]);
  });

  const SEPTEMBER = ['2026-09-01', '2026-09-30'] as const;

  it('Sales: the deals won in the period at their value — excluding tax, tax, including tax — by customer, user and quote owner', async () => {
    const byCustomer = await sales.generate(org, ...SEPTEMBER, 'customer');
    expect(byCustomer).toMatchObject({ deals: 4, totalSalesExTax: 250000, totalTax: 23000, totalSalesIncTax: 273000 });
    expect(byCustomer.groups).toEqual([
      { groupKey: 'sundar textiles', groupLabel: 'SUNDAR TEXTILES', deals: 2, salesExTax: 200000, tax: 23000, salesIncTax: 223000, percentOfSales: 80 },
      { groupKey: 'mugs order', groupLabel: 'Mugs order', deals: 1, salesExTax: 30000, tax: 0, salesIncTax: 30000, percentOfSales: 12 },
      { groupKey: 'kovai mills', groupLabel: 'Kovai Mills', deals: 1, salesExTax: 20000, tax: 0, salesIncTax: 20000, percentOfSales: 8 },
    ]);
    expect(byCustomer.dataSourceNote).toMatch(/^Counted: the 4 deals won in this period, by the day each closed, at the deal’s value — the same as the Dashboard’s revenue\./);
    expect(byCustomer.dataSourceNote).toMatch(/2 of them have no tax on their quotations, so nothing is taken off\./);

    const byUser = await sales.generate(org, ...SEPTEMBER, 'user');
    expect(byUser.groups.map((g) => [g.groupLabel, g.deals, g.salesExTax])).toEqual([
      ['Vasanth G', 2, 200000],
      ['Unassigned', 2, 50000],
    ]);
    const byOwner = await sales.generate(org, ...SEPTEMBER, 'quoteOwner');
    expect(byOwner.groups.map((g) => [g.groupLabel, g.salesIncTax])).toEqual([
      ['Vasanth G', 223000],
      ['No owner on the quotation', 30000],
      ['Sanjay Kumar', 20000],
    ]);
    expect(JSON.stringify(byOwner)).not.toMatch(/crm-77/);

    // Nothing won; the edges of the period count; a store sees its own deals.
    expect(await sales.generate(org, '2026-01-01', '2026-01-31', 'customer')).toMatchObject({ deals: 0, totalSalesExTax: 0, groups: [], dataSourceNote: 'No deal was won in this period.' });
    expect((await sales.generate(org, '2026-09-30', '2026-10-01', 'customer')).deals).toBe(2);
    expect(await sales.generate(org, ...SEPTEMBER, 'customer', 'store-b')).toMatchObject({ deals: 1, totalSalesIncTax: 20000 });
  });

  it('Gross Margin: the percentage set once, on the won sales excluding tax', async () => {
    expect(await margin.generate(org, ...SEPTEMBER, 'customer')).toMatchObject({ marginPct: null, grossMargin: null, deals: 4, totalSalesExTax: 250000 });
    await settings.setGrossMarginPct(org, 40, { id: owner, name: 'Vasanth G' });
    const after = await margin.generate(org, ...SEPTEMBER, 'user');
    expect(after).toMatchObject({ marginPct: 40, grossMargin: 100000, deals: 4 });
    expect(after.groups.map((g) => [g.groupLabel, g.deals, g.grossMargin])).toEqual([
      ['Vasanth G', 2, 80000],
      ['Unassigned', 2, 20000],
    ]);
  });

  it('Royalty: on won sales excluding tax, deal by deal, newest first — and the exports say deals', async () => {
    await rules.createVersion(org, { royaltyPercentage: 6, capType: 'none', effectiveDate: '2026-01-01' }, owner);
    const report = await royalty.generateReport(org, ...SEPTEMBER, undefined, 'salesperson');
    expect(report).toMatchObject({ wonDeals: 4, salesExTax: 250000, tax: 23000, salesIncTax: 273000, royaltyBase: 'exTax', eligibleRevenue: 250000, totalDue: 15000 });
    expect(report.sales.map((l) => [l.dealName, l.customerName, l.date, l.quoteNumbers, l.salesExTax, l.tax, l.salesIncTax, l.royalty])).toEqual([
      ['Kovai - caps', 'Kovai Mills', '2026-09-30', 'Q-4', 20000, 0, 20000, 1200],
      ['Mugs order', 'Mugs order', '2026-09-25', undefined, 30000, 0, 30000, 1800],
      ['Sundar - caps', 'SUNDAR TEXTILES', '2026-09-20', 'Q-2b, Q-2', 100000, 18000, 118000, 6000],
      ['Sundar - polos', 'Sundar Textiles', '2026-09-03', 'Q-1', 100000, 5000, 105000, 6000],
    ]);
    expect(report.salesSummary).toEqual({ totalRecords: 4, totalSalesExTax: 250000, totalTax: 23000, totalSalesIncTax: 273000, totalRoyalty: 15000 });
    expect(report.groupedBreakdown).toEqual([
      { groupKey: owner, groupLabel: 'Vasanth G', totalSalesExTax: 200000, percentOfSales: 80, royaltyDue: 12000 },
      { groupKey: '__unassigned__', groupLabel: 'Unassigned', totalSalesExTax: 50000, percentOfSales: 20, royaltyDue: 3000 },
    ]);

    const exporter = new RoyaltyReportExportService();
    const rows = exporter.buildRows(report);
    expect(rows[0]).toEqual({ item: 'Deals Won', value: '4' });
    expect(Object.fromEntries(rows.map((r) => [r.item, r.value]))).toMatchObject({ 'Sales (Ex Tax)': '₹2,50,000.00', 'Total Due': '₹15,000.00' });
    expect((await exporter.toExcel(rows, report)).length).toBeGreaterThan(2000);

    // A later rule that does not exclude tax, with a ceiling: only periods from its date use it.
    await rules.createVersion(org, { royaltyPercentage: 6, capType: 'max', capValue: 10000, excludeTax: false, effectiveDate: '2026-09-15' }, owner);
    expect(await royalty.generateReport(org, ...SEPTEMBER)).toMatchObject({ royaltyBase: 'incTax', eligibleRevenue: 273000, royaltyFeeBeforeCap: 16380, totalDue: 10000, effectiveRoyaltyPct: 3.7 });
    expect(await royalty.generateReport(org, '2026-09-01', '2026-09-10')).toMatchObject({ royaltyBase: 'exTax', wonDeals: 1, eligibleRevenue: 100000, totalDue: 6000 });
    expect(await royalty.generateReport(`${org}-other`, ...SEPTEMBER)).toMatchObject({ royaltyRule: null, wonDeals: 1, salesIncTax: 999999, totalDue: 0 });
  });

  it('two CRMs: a report counts only the one shown on dashboards, in its own currency', async () => {
    const pantheras = new Types.ObjectId();
    const hoops = new Types.ObjectId();
    await connection.collection('crm_data_sources').insertMany([
      { _id: pantheras, organizationId: org, key: 'prospectconnect', provider: 'prospectconnect', metadata: {} },
      { _id: hoops, organizationId: org, key: 'hoops', provider: 'hoops', metadata: { currency: 'AUD' } },
    ]);
    await connection.collection('crm_deals').updateMany({ organizationId: org }, { $set: { dataSourceId: pantheras.toString() } });
    const h1 = (await connection.collection('crm_deals').insertOne({ organizationId: org, dataSourceId: hoops.toString(), name: 'H1', dealStatus: 'won', monetaryValue: 78.1, expectedClosingDate: '2026-09-21' })).insertedId.toString();
    const h2 = (await connection.collection('crm_deals').insertOne({ organizationId: org, dataSourceId: hoops.toString(), name: 'H2', dealStatus: 'won', monetaryValue: 110, expectedClosingDate: '2026-09-22' })).insertedId.toString();
    await connection.collection('crm_quotes').insertMany([
      { organizationId: org, dataSourceId: hoops.toString(), dealId: h1, quoteNumber: '4472', quoteAmount: 78.1, quoteStatus: 'accepted', clientApprovalStatus: 'approved', taxes: [{ amount: 7.1 }], createdAt: day('2026-09-20') },
      { organizationId: org, dataSourceId: hoops.toString(), dealId: h2, quoteNumber: '4473', quoteAmount: 110, quoteStatus: 'accepted', clientApprovalStatus: 'approved', taxes: [{ amount: 10 }], createdAt: day('2026-09-21') },
    ]);
    const shown = (sourceId: Types.ObjectId) => ({ organizationId: org, mode: 'source' as const, sourceIds: [sourceId.toString()], nativeSourceId: 'native' });

    const hoopsReport = await runWithDataSourceScope(shown(hoops), () => royalty.generateReport(org, ...SEPTEMBER));
    expect(hoopsReport).toMatchObject({ currency: 'AUD', wonDeals: 2, salesIncTax: 188.1, tax: 17.1, salesExTax: 171 });
    const panthersReport = await runWithDataSourceScope(shown(pantheras), () => royalty.generateReport(org, ...SEPTEMBER));
    expect(panthersReport).toMatchObject({ currency: 'INR', wonDeals: 4, salesIncTax: 273000 });
    expect(new RoyaltyReportExportService().buildRows(hoopsReport).find((r) => r.item === 'Sales (Including Tax)')?.value).toBe('A$188.10');
  });
});
