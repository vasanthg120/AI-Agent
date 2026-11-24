import { ForbiddenException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { SalesAnalyticsService } from '../crm/sales-analytics.service';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteSchema } from '../crm/schemas/quote.schema';
import { SalesTarget, SalesTargetSchema } from '../crm/schemas/sales-target.schema';
import { DataSourceScope } from '../data-sources/data-source-context';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { EmailFollowUpReminder, EmailFollowUpReminderSchema } from '../email-intelligence/schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { TeamActivityService } from '../team-activity/team-activity.service';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { BusinessesOverviewService } from './businesses-overview.service';

// Against a real Mongo: the Main Account owner's "All businesses" view. Every
// business's figures are its own (its default CRM only, its own currency), the
// lists behind them match the numbers, and nobody else — not a sub-account's
// admin, not the owner switched into a sub-account, not another Main Account —
// gets any of it.
describe('Main Account: every business at a glance (real Mongo)', () => {
  let connection: Connection;
  let service: BusinessesOverviewService;

  // 15:30 in India on 12 Nov 2026.
  const now = new Date('2026-11-12T10:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const id = () => new Types.ObjectId();
  const orgs = { main: id(), branch: id(), sydney: id(), otherMain: id(), otherSub: id() };
  const org = (k: keyof typeof orgs) => orgs[k].toString();
  const users = { owner: id(), ownerInBranch: id(), branchAdmin: id(), branchRep: id(), otherOwner: id(), mailboxOwner: id() };
  const user = (k: keyof typeof users) => users[k].toString();
  const sources = { branchNative: id(), branchCrm: id(), branchSecondCrm: id(), sydneyNative: id(), sydneyHoops: id(), mainNative: id(), otherSubNative: id() };
  const src = (k: keyof typeof sources) => sources[k].toString();

  const caller = (sub: keyof typeof users, organizationId: string, roles: string[], extra: Partial<JwtPayload> = {}): JwtPayload =>
    ({ sub: user(sub), organizationId, roles, email: `${sub}@example.com`, ...extra }) as JwtPayload;
  const mainOwner = () => caller('owner', org('main'), ['owner']);

  // Each business's default CRM, as DataSourcesService.resolveScope would give it.
  const scopes: Record<string, DataSourceScope> = {
    [org('main')]: { organizationId: org('main'), mode: 'default', sourceIds: [src('mainNative')], nativeSourceId: src('mainNative') },
    [org('branch')]: { organizationId: org('branch'), mode: 'default', sourceIds: [src('branchCrm')], nativeSourceId: src('branchNative') },
    [org('sydney')]: { organizationId: org('sydney'), mode: 'default', sourceIds: [src('sydneyHoops')], nativeSourceId: src('sydneyNative') },
    [org('otherSub')]: { organizationId: org('otherSub'), mode: 'default', sourceIds: [src('otherSubNative')], nativeSourceId: src('otherSubNative') },
  };

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
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
          { name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema },
        ]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    const emails = new EmailIntelligenceService(
      moduleRef.get(getModelToken(EmailIntelligenceItem.name)),
      moduleRef.get(getModelToken(EmailFollowUpReminder.name)),
      {} as never,
      {} as never,
      {} as never,
      { findById: async () => null, findAll: async () => [] } as never,
      {} as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );
    const teamScopes = new TeamScopeService(connection);
    service = new BusinessesOverviewService(
      connection,
      moduleRef.get(getModelToken(Deal.name)),
      moduleRef.get(getModelToken(Quote.name)),
      new SalesAnalyticsService(moduleRef.get(getModelToken(Deal.name)), moduleRef.get(getModelToken(SalesTarget.name)), connection),
      { resolveScope: async (organizationId: string) => scopes[organizationId] } as never,
      emails,
      // The Inbox's own mailbox check is tested with the sync; here: the branch's mailbox keeps failing.
      { mailboxHealth: async () => ({ status: 'failing', failingSince: new Date(now.getTime() - 5 * HOUR), reason: 'Microsoft 365 didn’t answer.' }) } as never,
      new TeamActivityService(connection, teamScopes, emails),
      teamScopes,
    );

    const db = connection;
    await db.collection('organizations').insertMany([
      { _id: orgs.main, slug: `jest-biz-${orgs.main}`, name: 'jest-biz Main', timezone: 'Asia/Kolkata', status: 'active' },
      { _id: orgs.branch, slug: `jest-biz-${orgs.branch}`, name: 'jest-biz Branch', timezone: 'Asia/Kolkata', status: 'active', parentOrganizationId: org('main') },
      { _id: orgs.sydney, slug: `jest-biz-${orgs.sydney}`, name: 'jest-biz Sydney', timezone: 'Australia/Sydney', status: 'active', parentOrganizationId: org('main') },
      { _id: orgs.otherMain, slug: `jest-biz-${orgs.otherMain}`, name: 'jest-biz Other', timezone: 'Asia/Kolkata', status: 'active' },
      { _id: orgs.otherSub, slug: `jest-biz-${orgs.otherSub}`, name: 'jest-biz Other Branch', timezone: 'Asia/Kolkata', status: 'active', parentOrganizationId: org('otherMain') },
    ]);
    await db.collection('users').insertMany([
      { _id: users.owner, organizationId: org('main'), name: 'Main Owner', roles: ['owner'] },
      { _id: users.ownerInBranch, organizationId: org('branch'), name: 'Main Owner', roles: ['admin'], linkedLoginUserId: user('owner') },
      { _id: users.branchAdmin, organizationId: org('branch'), name: 'Branch Admin', roles: ['admin'] },
      { _id: users.branchRep, organizationId: org('branch'), name: 'Branch Rep', roles: ['agent_user'] },
      { _id: users.mailboxOwner, organizationId: org('branch'), name: 'Enquiries', roles: ['agent_user'] },
      { _id: users.otherOwner, organizationId: org('otherMain'), name: 'Other Owner', roles: ['owner'] },
    ]);
    await db.collection('crm_data_sources').insertMany([
      { _id: sources.mainNative, organizationId: org('main'), key: 'haive_native', provider: 'haive_native', status: 'active' },
      { _id: sources.branchNative, organizationId: org('branch'), key: 'haive_native', provider: 'haive_native', status: 'active' },
      {
        _id: sources.branchCrm,
        organizationId: org('branch'),
        key: 'prospectconnect',
        provider: 'prospectconnect',
        label: 'Pantheras CRM',
        status: 'active',
        isDefault: true,
        sync: { enabled: true, intervalMinutes: 10, lastStatus: 'ok', lastSuccessAt: new Date(now.getTime() - HOUR) },
      },
      {
        _id: sources.branchSecondCrm,
        organizationId: org('branch'),
        key: 'gorilladash',
        provider: 'gorilladash',
        label: 'Gorilla Dash',
        status: 'active',
        sync: { enabled: true, intervalMinutes: 10, lastStatus: 'error', lastError: 'The CRM couldn’t be reached.', lastSuccessAt: new Date(now.getTime() - 30 * HOUR) },
      },
      { _id: sources.sydneyNative, organizationId: org('sydney'), key: 'haive_native', provider: 'haive_native', status: 'active' },
      {
        _id: sources.sydneyHoops,
        organizationId: org('sydney'),
        key: 'hoops',
        provider: 'hoops',
        label: 'Hoops CRM',
        status: 'active',
        isDefault: true,
        // Read once a night: three days without a sync is late.
        sync: { enabled: true, intervalMinutes: 1440, window: { start: '19:00', end: '05:00' }, lastStatus: 'ok', lastSuccessAt: new Date(now.getTime() - 72 * HOUR) },
      },
      { _id: sources.otherSubNative, organizationId: org('otherSub'), key: 'haive_native', provider: 'haive_native', status: 'active' },
    ]);
    const deal = (organizationId: string, dataSourceId: string, name: string, dealStatus: string, monetaryValue: number, expectedClosingDate?: string) => ({
      organizationId,
      dataSourceId,
      name,
      dealStatus,
      monetaryValue,
      ...(expectedClosingDate ? { expectedClosingDate } : {}),
    });
    await db.collection('crm_deals').insertMany([
      deal(org('branch'), src('branchCrm'), 'jest-biz won', 'won', 1000, '2026-11-05'),
      deal(org('branch'), src('branchCrm'), 'jest-biz lost', 'lost', 300, '2026-11-10'),
      deal(org('branch'), src('branchCrm'), 'jest-biz on time', 'open', 500, '2026-11-25'),
      deal(org('branch'), src('branchCrm'), 'jest-biz late', 'open', 700, '2026-11-02'),
      deal(org('branch'), src('branchCrm'), 'jest-biz undated', 'open', 50),
      deal(org('branch'), src('branchCrm'), 'jest-biz October', 'won', 999, '2026-10-15'),
      // Kept in the branch's second CRM, which is not the one its Dashboard shows.
      deal(org('branch'), src('branchSecondCrm'), 'jest-biz other CRM', 'won', 5000, '2026-11-06'),
      deal(org('sydney'), src('sydneyHoops'), 'jest-biz Sydney won', 'won', 2000, '2026-11-03'),
      deal(org('sydney'), src('sydneyHoops'), 'jest-biz Sydney late', 'open', 400, '2026-10-01'),
      deal(org('otherSub'), src('otherSubNative'), 'jest-biz not ours', 'won', 777, '2026-11-04'),
    ]);
    await db.collection('crm_quotes').insertMany([
      { organizationId: org('branch'), dataSourceId: src('branchCrm'), quoteName: 'jest-biz Q accepted', quoteAmount: 100, clientApprovalStatus: 'approved', createdAt: new Date('2026-11-03T05:00:00Z') },
      { organizationId: org('branch'), dataSourceId: src('branchCrm'), quoteName: 'jest-biz Q sent', quoteAmount: 200, clientApprovalStatus: 'pending', createdAt: new Date('2026-11-04T05:00:00Z') },
      { organizationId: org('branch'), dataSourceId: src('branchCrm'), quoteName: 'jest-biz Q October', quoteAmount: 900, createdAt: new Date('2026-10-20T05:00:00Z') },
    ]);
    await db.collection('sales_targets').insertOne({ organizationId: org('branch'), scope: 'store', storeId: 'jest-biz-store', period: '2026-11', targetAmount: 4000, currency: 'INR' });
    const mail = (subject: string, hoursAgo: number, extra: Record<string, unknown>) => ({
      organizationId: org('branch'),
      userId: user('mailboxOwner'),
      mailboxEmail: 'enquiry@branch.example',
      externalMessageId: `jest-biz-${subject}`,
      receivedAt: new Date(now.getTime() - hoursAgo * HOUR),
      subject,
      fromAddress: 'forms@relay.example',
      replyToAddresses: ['customer@example.com'],
      toAddresses: ['enquiry@branch.example'],
      bodyPreview: '',
      isRead: false,
      importance: 'normal',
      matchConfidence: 'none',
      priority: 'normal',
      urgency: 'normal',
      sentiment: 'neutral',
      recommendedAction: '',
      status: 'pending',
      analysisAttempts: 0,
      regeneratedCount: 0,
      wasEdited: false,
      deterministicInput: {},
      result: {},
      ...extra,
    });
    await db.collection('email_intelligence_items').insertMany([
      mail('jest-biz enquiry, 3 days', 72, { intent: 'new_enquiry', expectedNextAction: 'company_reply', reason: 'Wants 40 hampers.' }),
      mail('jest-biz question, 2 hours', 2, { intent: 'existing_customer', expectedNextAction: 'company_reply' }),
      mail('jest-biz answered', 30, { intent: 'existing_customer', expectedNextAction: 'company_reply', sentAt: new Date(now.getTime() - 20 * HOUR) }),
      mail('jest-biz newsletter', 5, { intent: 'spam', expectedNextAction: 'no_action_required' }),
    ]);
    await db.collection('outlook_connections').insertOne({ organizationId: org('branch'), userId: user('mailboxOwner'), email: 'enquiry@branch.example', isActive: true, status: 'connected' });
    await db.collection('billing_subscriptions').insertOne({ organizationId: org('branch'), status: 'active' });
    await db.collection('plivo_calls').insertMany([
      { organizationId: org('branch'), userId: user('branchRep'), direction: 'outbound', createdAt: new Date('2026-11-10T06:00:00Z'), answeredAt: new Date('2026-11-10T06:00:10Z'), durationSeconds: 60 },
      { organizationId: org('branch'), userId: user('branchRep'), direction: 'inbound', createdAt: new Date('2026-11-11T06:00:00Z') },
    ]);
  });

  afterAll(async () => {
    const ids = Object.values(orgs).map((o) => o.toString());
    for (const name of ['crm_deals', 'crm_quotes', 'sales_targets', 'email_intelligence_items', 'outlook_connections', 'billing_subscriptions', 'plivo_calls', 'crm_data_sources', 'users']) {
      await connection.collection(name).deleteMany({ organizationId: { $in: ids } });
    }
    await connection.collection('organizations').deleteMany({ _id: { $in: Object.values(orgs) } });
    await connection.close();
  });

  const overview = () => service.overview(mainOwner(), '2026-11-01', '2026-11-12', now);
  const row = async (k: keyof typeof orgs) => (await overview()).businesses.find((b) => b.id === org(k))!;

  it('lists the Main Account and each of its sub-accounts — never another Main Account’s', async () => {
    const result = await overview();
    expect(result.businesses.map((b) => b.id).sort()).toEqual([org('main'), org('branch'), org('sydney')].sort());
    expect(result.businesses.find((b) => b.id === org('main'))!.isMain).toBe(true);
  });

  it('counts a business’s deals as its own Dashboard does: its default CRM, months by closing date', async () => {
    const branch = await row('branch');
    // The 5,000 deal sits in the branch's second CRM and the 999 one closed in October: neither counts.
    expect(branch.revenue).toMatchObject({ achieved: 1000, target: 4000, pct: 25 });
    expect(branch.deals.won).toEqual({ count: 1, value: 1000 });
    expect(branch.deals.lost).toEqual({ count: 1, value: 300 });
    expect(branch.deals.open).toEqual({ count: 2, value: 1200 });
    expect(branch.deals.winRatePct).toBe(50);
    // Every open deal now, whatever its month; only a closing date that has gone by is "past due".
    expect(branch.pipeline.open).toEqual({ count: 3, value: 1250 });
    expect(branch.pipeline.pastDue).toEqual({ count: 1, value: 700 });
    expect(branch.quotes).toEqual({ created: { count: 2, value: 300 }, accepted: { count: 1, value: 100 } });
  });

  it('keeps each business in its own currency, and never adds two currencies together', async () => {
    const result = await overview();
    const sydney = result.businesses.find((b) => b.id === org('sydney'))!;
    expect(sydney.currency).toBe('AUD');
    expect(sydney.deals.won).toEqual({ count: 1, value: 2000 });
    const inr = result.totals.byCurrency.find((t) => t.currency === 'INR')!;
    const aud = result.totals.byCurrency.find((t) => t.currency === 'AUD')!;
    expect(inr.revenue).toBe(1000);
    expect(aud.revenue).toBe(2000);
    expect(aud.pastDue).toEqual({ count: 1, value: 400 });
  });

  it('emails waiting are the Inbox’s own: owed a reply, across the business’s mailboxes', async () => {
    const branch = await row('branch');
    expect(branch.emails).toMatchObject({ waiting: 2, overdue: 1, newEnquiries: 1 });
    const list = await service.list(mainOwner(), 'emails_waiting', { organizationId: org('branch'), dateFrom: '2026-11-01', dateTo: '2026-11-12' }, now);
    expect(list.total).toBe(2);
    // Longest waiting first; a website form's customer is its Reply-To; the AI's reading comes along.
    expect(list.items.map((i) => i.title)).toEqual(['jest-biz enquiry, 3 days', 'jest-biz question, 2 hours']);
    expect(list.items[0].meta).toContain('customer@example.com');
    expect(list.items[0].meta).toContain('waiting 3 days');
    expect(list.items[0].note).toBe('Wants 40 hampers.');
  });

  it('calls come from Agent Activity, in the business’s own days', async () => {
    const branch = await row('branch');
    expect(branch.calls).toMatchObject({ total: 2, connected: 1, missed: 1, talkSeconds: 60 });
  });

  it('says what needs the owner’s eye: a locked sub-account, a mailbox or CRM that stopped, waiting email, late deals', async () => {
    const { attention } = await overview();
    const lines = attention.map((a) => `${a.severity} ${a.businessName}: ${a.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        'critical jest-biz Sydney: No active subscription — its team can only open Billing.',
        expect.stringMatching(/^critical jest-biz Branch: Mailbox enquiry@branch\.example isn’t being read since .*: Microsoft 365 didn’t answer\.$/),
        expect.stringMatching(/^critical jest-biz Branch: Gorilla Dash isn’t syncing since .*: The CRM couldn’t be reached\.$/),
        expect.stringMatching(/^warning jest-biz Sydney: Hoops CRM last synced /),
        'warning jest-biz Branch: 2 emails waiting for a reply, 1 of them over 24 hours — 1 new enquiry.',
        'warning jest-biz Branch: 1 open deal past the closing date (₹700).',
        'warning jest-biz Sydney: 1 open deal past the closing date (A$400).',
        'info jest-biz Branch: 1 missed call in this period.',
      ]),
    );
    // Worst first.
    const order = attention.map((a) => a.severity);
    expect(order).toEqual([...order].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
    expect((await row('branch')).locked).toBe(false);
    expect((await row('sydney')).locked).toBe(true);
  });

  it('the lists behind the numbers match them, across businesses, each row in its own currency', async () => {
    const range = { dateFrom: '2026-11-01', dateTo: '2026-11-12' };
    const late = await service.list(mainOwner(), 'past_due', range, now);
    expect(late.total).toBe(2);
    expect(late.items.map((i) => [i.title, i.value, i.currency])).toEqual([
      ['jest-biz late', 700, 'INR'],
      ['jest-biz Sydney late', 400, 'AUD'],
    ]);
    const won = await service.list(mainOwner(), 'won', { ...range, organizationId: org('branch') }, now);
    expect(won.items.map((i) => i.title)).toEqual(['jest-biz won']);
    const quotes = await service.list(mainOwner(), 'quotes_accepted', { ...range, organizationId: org('branch') }, now);
    expect(quotes.items.map((i) => i.title)).toEqual(['jest-biz Q accepted']);
  });

  it('is for the Main Account owner only', async () => {
    const refused = [
      // A sub-account's own admin.
      caller('branchAdmin', org('branch'), ['admin']),
      // The Main owner after switching into the sub-account.
      caller('ownerInBranch', org('branch'), ['admin'], { loginUserId: user('owner') }),
    ];
    for (const who of refused) await expect(service.overview(who, '2026-11-01', '2026-11-12', now)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('another Main Account’s owner sees their own businesses only', async () => {
    const theirs = await service.overview(caller('otherOwner', org('otherMain'), ['owner']), '2026-11-01', '2026-11-12', now);
    expect(theirs.businesses.map((b) => b.id).sort()).toEqual([org('otherMain'), org('otherSub')].sort());
    expect(theirs.totals.byCurrency.find((t) => t.currency === 'INR')!.revenue).toBe(777);
  });

  it('refuses another Main Account’s sub-account, even by id', async () => {
    await expect(service.list(mainOwner(), 'won', { organizationId: org('otherSub'), dateFrom: '2026-11-01', dateTo: '2026-11-12' }, now)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Haive's spoken briefing reads the same figures (backend/src/assistant).
  describe('for the spoken briefing', () => {
    it('anyone who sees a whole business team gets its figures; a store manager or a team member does not', async () => {
      const admin = await service.forBriefing(caller('branchAdmin', org('branch'), ['admin']), '2026-11-01', '2026-11-12', now);
      expect(admin!.businesses.map((b) => b.id)).toEqual([org('branch')]);
      expect(admin!.businesses[0].revenue.achieved).toBe(1000);
      expect(await service.forBriefing(caller('branchRep', org('branch'), ['agent_user']), '2026-11-01', '2026-11-12', now)).toBeNull();
      expect(await service.forBriefing(caller('branchAdmin', org('branch'), ['manager'], { storeId: 'store-1' }), '2026-11-01', '2026-11-12', now)).toBeNull();
      // The Main Account owner: every business, as on the Dashboard's All businesses.
      expect((await service.forBriefing(mainOwner(), '2026-11-01', '2026-11-12', now))!.businesses).toHaveLength(3);
    });

    it('adds quotations awaiting the customer’s decision and the biggest deals closing this week', async () => {
      const soon = await connection.collection('crm_deals').insertOne({ organizationId: org('branch'), dataSourceId: src('branchCrm'), name: 'jest-biz closing Friday', dealStatus: 'open', monetaryValue: 900, expectedClosingDate: '2026-11-14' });
      try {
        const extras = await service.briefingExtras(caller('branchAdmin', org('branch'), ['admin']), now);
        const branch = extras.get(org('branch'))!;
        // The 200 "pending" quotation of 4 Nov counts; the accepted one and the October one don't.
        expect(branch.quotesAwaitingDecision).toEqual({ count: 1, value: 200 });
        // Closing within seven days of 12 Nov: only the one on the 14th (the 25th is later, the 2nd has passed).
        expect(branch.closingThisWeek).toEqual([{ name: 'jest-biz closing Friday', value: 900, closes: '2026-11-14' }]);
        expect((await service.briefingExtras(caller('branchRep', org('branch'), ['agent_user']), now)).size).toBe(0);
      } finally {
        await connection.collection('crm_deals').deleteOne({ _id: soon.insertedId });
      }
    });
  });
});
