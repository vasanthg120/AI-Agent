import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { RoyaltyReportExportService } from '../royalty/royalty-report-export.service';
import { RoyaltyReportService, royaltyOn } from '../royalty/royalty-report.service';
import { RoyaltyRulesService } from '../royalty/royalty-rules.service';
import { RoyaltyRule, RoyaltyRuleDocument, RoyaltyRuleSchema } from '../royalty/schemas/royalty-rule.schema';
import { GrossMarginReportService, marginOn } from './gross-margin-report.service';
import { NO_CUSTOMER, quotationSale, QuotationSalesService, totalsOf } from './quotation-sales.service';
import { ReportingSettingsService } from './reporting-settings.service';
import { SalesReportService } from './sales-report.service';

const PREFIX = `jest-reports-${Date.now()}`;

// What a quotation says about itself, and the arithmetic on top of it. No database.
describe('quotations as sales', () => {
  const quote = (over: Record<string, unknown> = {}) => ({
    _id: 'q1',
    quoteAmount: 105000,
    clientApprovalStatus: 'approved',
    createdAt: new Date('2026-09-10T06:00:00Z'),
    ...over,
  });

  it('a quotation’s amount includes its tax: excluding tax is the amount less its tax lines', () => {
    expect(
      quotationSale(quote({ taxes: [{ name: 'GST', amount: 5000 }], clientDetails: { companyName: ' Sundar Textiles ' }, quoteNumber: 'Q-1' })),
    ).toMatchObject({
      number: 'Q-1',
      customer: 'Sundar Textiles',
      accepted: true,
      salesIncTax: 105000,
      tax: 5000,
      salesExTax: 100000,
      taxRecorded: true,
    });
    // Several tax lines add up; paise survive.
    expect(
      quotationSale(
        quote({
          quoteAmount: 1180.5,
          taxes: [
            { name: 'CGST', amount: 90.04 },
            { name: 'SGST', amount: 90.04 },
          ],
        }),
      ),
    ).toMatchObject({ tax: 180.08, salesExTax: 1000.42 });
  });

  it('no tax line: nothing is taken off, and the quotation says so', () => {
    expect(quotationSale(quote())).toMatchObject({ salesIncTax: 105000, tax: 0, salesExTax: 105000, taxRecorded: false });
    expect(quotationSale(quote({ taxes: [] }))).toMatchObject({ tax: 0, taxRecorded: false });
    // A quotation written in HaiVE carries one tax amount instead of lines.
    expect(quotationSale(quote({ taxAmount: 5000 }))).toMatchObject({ tax: 5000, salesExTax: 100000, taxRecorded: true });
  });

  it('never more tax than the quotation is worth, never a negative figure', () => {
    expect(quotationSale(quote({ quoteAmount: 1000, taxes: [{ amount: 5000 }] }))).toMatchObject({ tax: 1000, salesExTax: 0 });
    expect(quotationSale(quote({ quoteAmount: -50, taxes: [{ amount: -5 }] }))).toMatchObject({ salesIncTax: 0, tax: 0, salesExTax: 0 });
    expect(quotationSale(quote({ quoteAmount: 'lots', taxes: 'none' }))).toMatchObject({ salesIncTax: 0, tax: 0 });
  });

  it('who it is for: the company, else the contact, else the quotation’s name', () => {
    expect(quotationSale(quote({ clientDetails: { contactName: 'Priya Raman' }, quoteName: 'Polos' })).customer).toBe('Priya Raman');
    expect(quotationSale(quote({ quoteName: 'Polos' })).customer).toBe('Polos');
    expect(quotationSale(quote()).customer).toBe(NO_CUSTOMER);
    expect(quotationSale(quote({ clientApprovalStatus: 'awaiting_response' })).accepted).toBe(false);
  });

  it('totals add up to the paisa', () => {
    const sales = [
      quote({ quoteAmount: 100.1, taxes: [{ amount: 0.1 }] }),
      quote({ quoteAmount: 200.2, taxes: [{ amount: 0.2 }] }),
      quote({ quoteAmount: 50, clientApprovalStatus: 'awaiting_response' }),
    ].map(quotationSale);
    expect(totalsOf(sales)).toEqual({ quotations: 3, accepted: 2, withoutTax: 1, salesExTax: 350, tax: 0.3, salesIncTax: 350.3 });
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
    expect(royaltyOn(220000, rule({ capType: 'min', capValue: 5000 }))).toMatchObject({ totalDue: 13200 });
    const sliding = rule({
      capType: 'sliding',
      slidingTiers: [
        { fromValue: 0, toValue: 100000, percentage: 8 },
        { fromValue: 100000, percentage: 5 },
      ],
    });
    expect(royaltyOn(50000, sliding)).toEqual({ ratePct: 8, feeBeforeCap: 4000, totalDue: 4000 });
    expect(royaltyOn(220000, sliding)).toEqual({ ratePct: 5, feeBeforeCap: 11000, totalDue: 11000 });
    expect(royaltyOn(0, rule())).toEqual({ ratePct: 6, feeBeforeCap: 0, totalDue: 0 });
  });
});

// Against a real Mongo: the three reports count the same quotations — every
// one sent in the period, by its own date — with the quotation's own value and
// tax; no invoice and no cost is read; and nothing crosses organizations.
describe('Sales, Gross Margin and Royalty reports (real Mongo)', () => {
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
    for (const name of ['crm_quotes', 'crm_deals', 'users', 'reporting_settings', 'royalty_rules', 'royalty_invoices']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  const day = (d: string) => new Date(`${d}T06:30:00Z`);

  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    const users = { findAll: async (organizationId: string) => connection.collection('users').find({ organizationId }).toArray() };
    const quotations = new QuotationSalesService(connection);
    sales = new SalesReportService(quotations, users as never);
    settings = new ReportingSettingsService(connection);
    margin = new GrossMarginReportService(quotations, sales, settings);
    rules = new RoyaltyRulesService(ruleModel);
    royalty = new RoyaltyReportService(quotations, sales, rules);

    owner = (
      await connection.collection('users').insertOne({ organizationId: org, name: 'Vasanth G', email: `${org}@example.test`, roles: ['owner'] })
    ).insertedId.toString();
    const deal = async (name: string, more: Record<string, unknown> = {}) =>
      (await connection.collection('crm_deals').insertOne({ organizationId: org, name, dealStatus: 'open', monetaryValue: 1, ...more })).insertedId.toString();
    const d1 = await deal('Sundar - polos', { ownerId: owner, storeId: 'store-a' });
    const d2 = await deal('Kovai - caps', { storeId: 'store-b' });
    const quote = (number: string, amount: number, created: string, more: Record<string, unknown> = {}) => ({
      organizationId: org,
      quoteNumber: number,
      quoteName: `Order ${number}`,
      quoteAmount: amount,
      quoteStatus: 'published',
      clientApprovalStatus: 'approved',
      createdAt: day(created),
      ...more,
    });
    await connection.collection('crm_quotes').insertMany([
      quote('Q-1', 105000, '2026-09-03', {
        dealId: d1,
        taxes: [{ name: 'GST', amount: 5000 }],
        clientDetails: { companyName: 'Sundar Textiles' },
        ownerUserId: owner,
      }),
      // The same customer typed in another case (one row, named as on their latest quotation); sent but not accepted yet.
      quote('Q-2', 118000, '2026-09-20', {
        dealId: d1,
        taxes: [{ name: 'GST', amount: 18000 }],
        clientDetails: { companyName: 'SUNDAR TEXTILES' },
        clientApprovalStatus: 'awaiting_response',
        ownerUserId: owner,
      }),
      // No tax line at all; its owner is known only by the CRM's name for them.
      quote('Q-4', 20000, '2026-09-30', { dealId: d2, clientDetails: { companyName: 'Kovai Mills' }, quoteOwner: 'crm-77', quoteOwnerLabel: 'Sanjay Kumar' }),
      // Left out: a draft, one from another month, one of another organization.
      quote('Q-3', 50000, '2026-09-12', { dealId: d1, quoteStatus: 'draft', taxes: [{ name: 'GST', amount: 2000 }] }),
      quote('Q-5', 70000, '2026-10-01', { dealId: d1, taxes: [{ name: 'GST', amount: 3000 }] }),
      { ...quote('Q-9', 999999, '2026-09-15', { taxes: [{ name: 'GST', amount: 9 }] }), organizationId: `${org}-other` },
    ]);
    // Invoices and costs exist in the database; the reports must not read them.
    await connection.collection('royalty_invoices').insertOne({
      organizationId: org,
      invoiceNumber: 'INV-1',
      invoiceDate: day('2026-09-05'),
      currentValue: 777777,
      costAmount: 111111,
      taxAmount: 333,
      voidStatus: false,
    });
  });

  const SEPTEMBER = ['2026-09-01', '2026-09-30'] as const;

  it('Sales: every quotation sent in the period, excluding tax, its tax and including tax — by customer, user and quote owner', async () => {
    const byCustomer = await sales.generate(org, ...SEPTEMBER, 'customer');
    expect(byCustomer).toMatchObject({ quotations: 3, accepted: 2, totalSalesExTax: 220000, totalTax: 23000, totalSalesIncTax: 243000 });
    expect(byCustomer.groups).toEqual([
      { groupKey: 'sundar textiles', groupLabel: 'SUNDAR TEXTILES', quotations: 2, salesExTax: 200000, tax: 23000, salesIncTax: 223000, percentOfSales: 90.9 },
      { groupKey: 'kovai mills', groupLabel: 'Kovai Mills', quotations: 1, salesExTax: 20000, tax: 0, salesIncTax: 20000, percentOfSales: 9.1 },
    ]);
    expect(byCustomer.dataSourceNote).toMatch(
      /^Counted: all 3 quotations sent in this period, by the quotation’s date — 2 accepted by the customer, 1 not accepted yet\. Drafts are left out\./,
    );
    expect(byCustomer.dataSourceNote).toMatch(/1 of them carries no tax line, so nothing is taken off its amount\./);

    const byUser = await sales.generate(org, ...SEPTEMBER, 'user');
    expect(byUser.groups.map((g) => [g.groupLabel, g.quotations, g.salesExTax])).toEqual([
      ['Vasanth G', 2, 200000],
      ['Unassigned', 1, 20000],
    ]);
    const byOwner = await sales.generate(org, ...SEPTEMBER, 'quoteOwner');
    expect(byOwner.groups.map((g) => [g.groupLabel, g.salesIncTax])).toEqual([
      ['Vasanth G', 223000],
      ['Sanjay Kumar', 20000],
    ]);
    // The CRM's own id for an owner never reaches the report.
    expect(JSON.stringify(byOwner)).not.toMatch(/crm-77/);

    // A period with nothing in it; a day on the edge counts.
    expect(await sales.generate(org, '2026-01-01', '2026-01-31', 'customer')).toMatchObject({
      quotations: 0,
      totalSalesExTax: 0,
      groups: [],
      dataSourceNote: 'No quotation was sent in this period.',
    });
    expect((await sales.generate(org, '2026-09-30', '2026-10-01', 'customer')).quotations).toBe(2);
    // A manager sees the quotations of their own store's deals only.
    expect(await sales.generate(org, ...SEPTEMBER, 'customer', 'store-b')).toMatchObject({ quotations: 1, totalSalesIncTax: 20000 });
  });

  it('Gross Margin: the percentage set once, applied to sales excluding tax — and blank until it is set', async () => {
    const before = await margin.generate(org, ...SEPTEMBER, 'customer');
    expect(before).toMatchObject({ marginPct: null, grossMargin: null, totalSalesExTax: 220000, totalTax: 23000, totalSalesIncTax: 243000, quotations: 3 });
    expect(before.groups.map((g) => [g.groupLabel, g.salesExTax, g.grossMargin])).toEqual([
      ['SUNDAR TEXTILES', 200000, null],
      ['Kovai Mills', 20000, null],
    ]);
    expect(before.note).toMatch(/^No gross margin percentage is set yet/);

    expect(await settings.setGrossMarginPct(org, 40, { id: owner, name: 'Vasanth G' })).toMatchObject({ grossMarginPct: 40, updatedByName: 'Vasanth G' });
    const after = await margin.generate(org, ...SEPTEMBER, 'customer');
    expect(after).toMatchObject({ marginPct: 40, grossMargin: 88000 });
    expect(after.groups).toEqual([
      { groupKey: 'sundar textiles', groupLabel: 'SUNDAR TEXTILES', quotations: 2, salesExTax: 200000, tax: 23000, salesIncTax: 223000, grossMargin: 80000 },
      { groupKey: 'kovai mills', groupLabel: 'Kovai Mills', quotations: 1, salesExTax: 20000, tax: 0, salesIncTax: 20000, grossMargin: 8000 },
    ]);
    expect(after.note).toMatch(/^Gross margin is an estimate: 40% of sales excluding tax/);
    expect((await margin.generate(org, ...SEPTEMBER, 'user')).groups.map((g) => [g.groupLabel, g.grossMargin])).toEqual([
      ['Vasanth G', 80000],
      ['Unassigned', 8000],
    ]);

    // One organization's percentage is nobody else's; and it can be cleared again.
    expect(await settings.get(`${org}-other`)).toMatchObject({ grossMarginPct: null });
    expect(await settings.setGrossMarginPct(org, 37.555, { id: owner, name: 'Vasanth G' })).toMatchObject({ grossMarginPct: 37.56 });
    expect(await settings.setGrossMarginPct(org, null, { id: owner, name: 'Vasanth G' })).toMatchObject({ grossMarginPct: null });
    expect((await margin.generate(org, ...SEPTEMBER, 'customer')).grossMargin).toBeNull();
    expect(await connection.collection('reporting_settings').countDocuments({ organizationId: org })).toBe(1);
  });

  it('Royalty: charged on sales excluding tax, at the rule in force, quotation by quotation', async () => {
    const without = await royalty.generateReport(org, ...SEPTEMBER);
    expect(without).toMatchObject({
      royaltyRule: null,
      totalQuotes: 3,
      totalAcceptedQuotes: 2,
      totalNotAcceptedQuotes: 1,
      salesExTax: 220000,
      tax: 23000,
      salesIncTax: 243000,
      royaltyBase: 'exTax',
      eligibleRevenue: 220000,
      royaltyFeeBeforeCap: 0,
      totalDue: 0,
      effectiveRoyaltyPct: null,
    });

    await rules.createVersion(org, { royaltyPercentage: 6, capType: 'none', effectiveDate: '2026-01-01' }, owner);
    const report = await royalty.generateReport(org, ...SEPTEMBER, undefined, 'salesperson');
    expect(report).toMatchObject({
      royaltyRule: { royaltyPercentage: 6, excludeTax: true },
      royaltyBase: 'exTax',
      eligibleRevenue: 220000,
      royaltyFeeBeforeCap: 13200,
      totalDue: 13200,
      effectiveRoyaltyPct: 6,
    });
    // Newest first; each with its own three amounts and its royalty.
    expect(report.quotations.map((q) => [q.quoteNumber, q.customerName, q.date, q.accepted, q.salesExTax, q.tax, q.salesIncTax, q.royalty])).toEqual([
      ['Q-4', 'Kovai Mills', '2026-09-30', true, 20000, 0, 20000, 1200],
      ['Q-2', 'SUNDAR TEXTILES', '2026-09-20', false, 100000, 18000, 118000, 6000],
      ['Q-1', 'Sundar Textiles', '2026-09-03', true, 100000, 5000, 105000, 6000],
    ]);
    expect(report.quotationsSummary).toEqual({ totalRecords: 3, totalSalesExTax: 220000, totalTax: 23000, totalSalesIncTax: 243000, totalRoyalty: 13200 });
    expect(report.groupedBreakdown).toEqual([
      { groupKey: owner, groupLabel: 'Vasanth G', totalSalesExTax: 200000, percentOfSales: 90.9, royaltyDue: 12000 },
      { groupKey: '__unassigned__', groupLabel: 'Unassigned', totalSalesExTax: 20000, percentOfSales: 9.1, royaltyDue: 1200 },
    ]);
    expect(report.dataSourceNote).toMatch(/Royalty is charged on sales excluding tax\.$/);

    // Nothing of an invoice or a cost is in the report, the exported summary or its sheets.
    expect(JSON.stringify(report)).not.toMatch(/invoice|cost|777777|111111/i);
    const exporter = new RoyaltyReportExportService();
    const rows = exporter.buildRows(report);
    expect(rows.map((r) => r.item)).toEqual([
      'Quotations Sent',
      'Accepted Quotations',
      'Not Accepted Yet',
      'Sales (Ex Tax)',
      'Tax',
      'Sales (Including Tax)',
      'Royalty Charged On',
      'Royalty Percentage',
      'Royalty Fee (before cap)',
      'Total Due',
      'Effective Royalty % (after cap)',
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.item, r.value]))).toMatchObject({
      'Sales (Ex Tax)': '₹2,20,000.00',
      Tax: '₹23,000.00',
      'Sales (Including Tax)': '₹2,43,000.00',
      'Royalty Charged On': 'Sales (Ex Tax)',
      'Total Due': '₹13,200.00',
    });
    expect(exporter.toCsv(rows)).toMatch(/"Sales \(Ex Tax\)","₹2,20,000.00"/);
    expect((await exporter.toExcel(rows, report)).length).toBeGreaterThan(2000);

    // A later rule that does not exclude tax, with a ceiling: only periods from its date use it.
    await rules.createVersion(
      org,
      { royaltyPercentage: 6, capType: 'max', capValue: 10000, excludeTax: false, marketingFeeAmount: 2500, effectiveDate: '2026-09-15' },
      owner,
    );
    expect(await royalty.generateReport(org, ...SEPTEMBER)).toMatchObject({
      royaltyRule: { excludeTax: false, capType: 'max' },
      royaltyBase: 'incTax',
      eligibleRevenue: 243000,
      royaltyFeeBeforeCap: 14580,
      totalDue: 10000,
      effectiveRoyaltyPct: 4.1,
      marketingFeeAmount: 2500,
    });
    expect(await royalty.generateReport(org, '2026-09-01', '2026-09-10')).toMatchObject({
      royaltyBase: 'exTax',
      totalQuotes: 1,
      eligibleRevenue: 100000,
      totalDue: 6000,
    });
    // Another organization has its own quotations and no rule of ours.
    expect(await royalty.generateReport(`${org}-other`, ...SEPTEMBER)).toMatchObject({ royaltyRule: null, totalQuotes: 1, salesIncTax: 999999, totalDue: 0 });
  });
});
