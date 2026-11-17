import { ForbiddenException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { EmailFollowUpReminder, EmailFollowUpReminderSchema } from '../email-intelligence/schemas/email-follow-up-reminder.schema';
import { TeamActivityService } from './team-activity.service';
import { periodDays, periodRange } from './team-period';
import { TeamScopeService } from './team-scope.service';

describe('team period', () => {
  // 20:30 in India on the 12th; already 02:00 on the 13th in Sydney (daylight time).
  const now = new Date('2026-11-12T15:00:00.000Z');

  it('"Today" is each business’s own today', () => {
    expect(periodDays('today', 'Asia/Kolkata', now)).toEqual({ from: '2026-11-12', to: '2026-11-12' });
    expect(periodDays('today', 'Australia/Sydney', now)).toEqual({ from: '2026-11-13', to: '2026-11-13' });
  });

  it('presets cover whole days back from today', () => {
    expect(periodDays('yesterday', 'Asia/Kolkata', now)).toEqual({ from: '2026-11-11', to: '2026-11-11' });
    expect(periodDays('last7', 'Asia/Kolkata', now)).toEqual({ from: '2026-11-06', to: '2026-11-12' });
    expect(periodDays('last30', 'Asia/Kolkata', now)).toEqual({ from: '2026-10-14', to: '2026-11-12' });
    expect(periodDays('month', 'Asia/Kolkata', now)).toEqual({ from: '2026-11-01', to: '2026-11-12' });
    expect(periodDays('previous_month', 'Asia/Kolkata', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodDays('previous_month', 'Asia/Kolkata', new Date('2026-01-05T06:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('turns days into the instants of the business’s midnights', () => {
    const range = periodRange('today', 'Asia/Kolkata', now);
    expect(range.start.toISOString()).toBe('2026-11-11T18:30:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-12T18:30:00.000Z');
  });

  it('checks a custom range', () => {
    expect(periodDays('custom', 'Asia/Kolkata', now, { from: '2026-11-01', to: '2026-11-05' })).toEqual({ from: '2026-11-01', to: '2026-11-05' });
    expect(periodDays('custom', 'Asia/Kolkata', now, { from: '2026-11-03' })).toEqual({ from: '2026-11-03', to: '2026-11-03' });
    expect(() => periodDays('custom', 'Asia/Kolkata', now, {})).toThrow();
    expect(() => periodDays('custom', 'Asia/Kolkata', now, { from: '2026-11-05', to: '2026-11-01' })).toThrow();
    expect(() => periodDays('custom', 'Asia/Kolkata', now, { from: '2024-01-01', to: '2026-01-01' })).toThrow();
  });
});

// Against a real Mongo: whose work each caller sees (the Main Account owner
// every business, an admin their own team, a manager their store, anyone else
// themselves), and every figure Agent Activity / Team Performance shows.
describe('team activity (real Mongo)', () => {
  let connection: Connection;
  let itemModel: Model<EmailIntelligenceItemDocument>;
  let scopes: TeamScopeService;
  let activity: TeamActivityService;

  // 15:30 in India on 2026-11-12: "today" there is 2026-11-11T18:30Z – 2026-11-12T18:30Z.
  const now = new Date('2026-11-12T10:00:00.000Z');
  const at = (iso: string) => new Date(iso);
  const id = () => new Types.ObjectId();
  const orgs = { main: id(), sub: id(), other: id() };
  const org = (key: keyof typeof orgs) => orgs[key].toString();
  const people = {
    mainOwner: id(),
    mainOwnerInSub: id(),
    subAdmin: id(),
    subManager: id(),
    rep: id(),
    rep2: id(),
    otherOwner: id(),
  };
  const who = (key: keyof typeof people) => people[key].toString();
  const deals = { d1: id(), d2: id(), d3: id(), d4: id(), d5: id(), d6: id(), d7: id() };
  const sessions = { phoneRecording: id(), live: id(), upload: id(), other: id() };

  const caller = (key: keyof typeof people, organizationId: string, roles: string[], extra: Partial<JwtPayload> = {}): JwtPayload =>
    ({ sub: who(key), organizationId, roles, email: `${key}@example.com`, ...extra }) as JwtPayload;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
          { name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema },
        ]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    itemModel = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    const emails = new EmailIntelligenceService(
      itemModel,
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
    scopes = new TeamScopeService(connection);
    activity = new TeamActivityService(connection, scopes, emails);

    const db = connection;
    await db.collection('organizations').insertMany([
      { _id: orgs.main, slug: `jest-team-${orgs.main}`, name: 'jest-team Main', timezone: 'Asia/Kolkata', status: 'active' },
      { _id: orgs.sub, slug: `jest-team-${orgs.sub}`, name: 'jest-team Branch', timezone: 'Asia/Kolkata', status: 'active', parentOrganizationId: org('main') },
      { _id: orgs.other, slug: `jest-team-${orgs.other}`, name: 'jest-team Other', timezone: 'Asia/Kolkata', status: 'active' },
    ]);
    await db.collection('users').insertMany([
      { _id: people.mainOwner, organizationId: org('main'), name: 'Main Owner', email: 'jest-team-owner@example.com', roles: ['owner'] },
      { _id: people.mainOwnerInSub, organizationId: org('sub'), name: 'Main Owner', roles: ['admin'], linkedLoginUserId: who('mainOwner') },
      { _id: people.subAdmin, organizationId: org('sub'), name: 'Branch Admin', roles: ['admin'] },
      { _id: people.subManager, organizationId: org('sub'), name: 'Store Manager', roles: ['manager'], storeId: 'store-1' },
      { _id: people.rep, organizationId: org('sub'), name: 'Rep One', roles: ['agent_user'], storeId: 'store-1' },
      { _id: people.rep2, organizationId: org('sub'), name: 'Rep Two', roles: ['consultant'] },
      { _id: people.otherOwner, organizationId: org('other'), name: 'Other Owner', roles: ['owner'] },
    ]);

    // Calls: two phone calls today (one answered, 5 minutes, recorded and
    // scored 8), one yesterday; a live Call Copilot call (10 minutes, scored 6);
    // Rep Two's uploaded recording (scored 0 = nothing to score).
    await db.collection('plivo_calls').insertMany([
      { organizationId: org('sub'), userId: who('rep'), direction: 'outbound', customerNumber: '+911', customerName: 'Acme', status: 'completed', answeredAt: at('2026-11-12T09:00:30Z'), durationSeconds: 300, sessionId: sessions.phoneRecording.toString(), createdAt: at('2026-11-12T09:00:00Z') },
      { organizationId: org('sub'), userId: who('rep'), direction: 'outbound', customerNumber: '+912', status: 'no_answer', durationSeconds: 0, createdAt: at('2026-11-12T09:30:00Z') },
      { organizationId: org('sub'), userId: who('rep'), direction: 'outbound', customerNumber: '+913', status: 'completed', answeredAt: at('2026-11-11T12:00:30Z'), durationSeconds: 120, createdAt: at('2026-11-11T12:00:00Z') },
      { organizationId: org('other'), userId: who('otherOwner'), direction: 'outbound', customerNumber: '+914', status: 'completed', answeredAt: at('2026-11-12T09:00:30Z'), durationSeconds: 60, createdAt: at('2026-11-12T09:00:00Z') },
    ]);
    await db.collection('call_sessions').insertMany([
      { _id: sessions.phoneRecording, organizationId: org('sub'), userId: who('rep'), source: 'upload', status: 'ended', overallScore: 8, headline: 'Acme pricing call', creditRequestId: `jest-team-${sessions.phoneRecording}`, transcript: [], createdAt: at('2026-11-12T09:10:00Z') },
      { _id: sessions.live, organizationId: org('sub'), userId: who('rep'), source: 'live', status: 'ended', overallScore: 6, creditRequestId: `jest-team-${sessions.live}`, transcript: [], createdAt: at('2026-11-12T08:00:00Z'), endedAt: at('2026-11-12T08:10:00Z') },
      { _id: sessions.upload, organizationId: org('sub'), userId: who('rep2'), source: 'upload', status: 'ended', overallScore: 0, creditRequestId: `jest-team-${sessions.upload}`, transcript: [], createdAt: at('2026-11-12T07:00:00Z') },
      { _id: sessions.other, organizationId: org('other'), userId: who('otherOwner'), source: 'live', status: 'ended', overallScore: 9, creditRequestId: `jest-team-${sessions.other}`, transcript: [], createdAt: at('2026-11-12T07:00:00Z') },
    ]);

    // Email: two sent today, one yesterday; one waiting (5 hours old), one
    // whose 24 hours ran out today (missed), one replied today.
    await db.collection('email_sent_items').insertMany([
      { organizationId: org('sub'), userId: who('rep'), mailboxEmail: 'rep@x.com', externalMessageId: `jest-team-s1-${now.getTime()}`, sentAt: at('2026-11-12T04:00:00Z'), subject: 'Quote', toAddresses: ['a@acme.com'], bodyPreview: 'Hi', inReplyTo: '<m1>' },
      { organizationId: org('sub'), userId: who('rep'), mailboxEmail: 'rep@x.com', externalMessageId: `jest-team-s2-${now.getTime()}`, sentAt: at('2026-11-12T05:00:00Z'), subject: 'Intro', toAddresses: ['b@beta.com'], bodyPreview: 'Hello' },
      { organizationId: org('sub'), userId: who('rep'), mailboxEmail: 'rep@x.com', externalMessageId: `jest-team-s3-${now.getTime()}`, sentAt: at('2026-11-11T05:00:00Z'), subject: 'Old', toAddresses: ['c@gamma.com'], bodyPreview: '' },
    ]);
    const email = (key: string, receivedAt: string, extra: Record<string, unknown> = {}) => ({
      organizationId: org('sub'),
      userId: who('rep'),
      mailboxEmail: 'rep@x.com',
      externalMessageId: `jest-team-${key}-${now.getTime()}`,
      receivedAt: at(receivedAt),
      subject: key,
      fromAddress: `${key}@customer.com`,
      intent: 'new_enquiry',
      expectedNextAction: 'company_reply',
      status: 'pending',
      ...extra,
    });
    await itemModel.collection.insertMany([
      email('waiting', '2026-11-12T05:00:00Z'),
      email('missed', '2026-11-11T06:00:00Z'),
      email('answered', '2026-11-12T02:00:00Z', { intent: 'existing_customer', sentAt: at('2026-11-12T03:00:00Z'), inReplyTo: '<our-quote>' }),
      // Answered today in Outlook with a question back to the customer, who hasn't written since.
      email('asked', '2026-11-11T08:00:00Z', { intent: 'existing_customer', externalReplyDetectedAt: at('2026-11-12T03:30:00Z'), replyAwaitsCustomer: true, threadHead: true }),
    ]);
    // Follow-ups: an email reminder overdue and one done today; a customer task open (no due date) and one done today.
    await db.collection('email_follow_up_reminders').insertMany([
      { organizationId: org('sub'), userId: who('rep'), emailIntelligenceItemId: `jest-team-r1-${people.rep}`, reminderType: 'post_reply', title: 'Chase Acme', dueDate: at('2026-11-11T05:00:00Z'), status: 'pending' },
      { organizationId: org('sub'), userId: who('rep'), emailIntelligenceItemId: `jest-team-r2-${people.rep}`, reminderType: 'post_reply', title: 'Send Beta the sample', dueDate: at('2026-11-12T05:00:00Z'), status: 'done', completedAt: at('2026-11-12T06:00:00Z') },
    ]);
    await db.collection('customer_tasks').insertMany([
      { organizationId: org('sub'), customerKeys: [], title: 'Call Gamma back', status: 'open', assigneeId: who('rep'), createdAt: at('2026-11-10T00:00:00Z') },
      { organizationId: org('sub'), customerKeys: [], title: 'Quote Delta', status: 'done', assigneeId: who('rep'), completedAt: at('2026-11-12T07:00:00Z'), createdAt: at('2026-11-09T00:00:00Z') },
    ]);

    // Deals created today: by Rep One in HaiVE; owned by Rep Two; by a CRM
    // salesperson linked to Rep One; by a shared CRM login; by an unlinked CRM
    // salesperson — and one by Rep One yesterday.
    await db.collection('crm_deals').insertMany([
      { _id: deals.d1, organizationId: org('sub'), name: 'D1', dealStatus: 'open', monetaryValue: 100, ownerId: who('rep') },
      { _id: deals.d2, organizationId: org('sub'), name: 'D2', dealStatus: 'open', monetaryValue: 200, ownerId: who('rep2') },
      { _id: deals.d3, organizationId: org('sub'), name: 'D3', dealStatus: 'won', monetaryValue: 300, externalOwnerRef: 'kshitij' },
      { _id: deals.d4, organizationId: org('sub'), name: 'D4', dealStatus: 'open', monetaryValue: 400, externalOwnerRef: 'enquiry' },
      { _id: deals.d5, organizationId: org('sub'), name: 'D5', dealStatus: 'open', monetaryValue: 500, externalOwnerRef: 'tom', externalOwnerLabel: 'Tom Renshaw' },
      { _id: deals.d6, organizationId: org('sub'), name: 'D6', dealStatus: 'open', monetaryValue: 600 },
      { _id: deals.d7, organizationId: org('sub'), name: 'D7', dealStatus: 'lost', monetaryValue: 700, ownerId: who('rep2') },
    ]);
    await db.collection('crm_deal_owner_mappings').insertMany([
      { organizationId: org('sub'), provider: 'hoops', externalOwnerRef: 'kshitij', externalOwnerLabel: 'Kshitij', linkedUserIds: [who('rep')], ownerId: who('rep'), shared: false },
      { organizationId: org('sub'), provider: 'hoops', externalOwnerRef: 'enquiry', externalOwnerLabel: 'Enquiry T.nagar', linkedUserIds: [], shared: true },
    ]);
    const created = (deal: Types.ObjectId, occurredAt: string, extra: Record<string, unknown> = {}) => ({
      organizationId: org('sub'),
      entity: 'deal',
      entityId: deal.toString(),
      kind: 'created',
      byAi: false,
      origin: 'crm_sync',
      occurredAt: at(occurredAt),
      occurredAtBasis: 'crm',
      dedupeKey: `jest-team:${deal}:created`,
      ...extra,
    });
    await db.collection('crm_activities').insertMany([
      created(deals.d1, '2026-11-12T04:00:00Z', { actorUserId: who('rep'), origin: 'haive' }),
      created(deals.d2, '2026-11-12T04:10:00Z'),
      created(deals.d3, '2026-11-12T04:20:00Z', { crmOwnerRef: 'kshitij' }),
      created(deals.d4, '2026-11-12T04:30:00Z', { crmOwnerRef: 'enquiry', crmOwnerLabel: 'Enquiry T.nagar' }),
      created(deals.d5, '2026-11-12T04:40:00Z', { crmOwnerRef: 'tom', crmOwnerLabel: 'Tom Renshaw' }),
      created(deals.d6, '2026-11-11T04:00:00Z', { actorUserId: who('rep'), origin: 'haive' }),
      created(deals.d3, '2026-11-12T08:00:00Z', { kind: 'won', crmOwnerRef: 'kshitij', dedupeKey: `jest-team:${deals.d3}:won` }),
      created(deals.d7, '2026-11-12T08:30:00Z', { kind: 'lost', dedupeKey: `jest-team:${deals.d7}:lost` }),
    ]);
  });

  afterAll(async () => {
    const ids = Object.values(orgs).map((o) => o.toString());
    await connection.collection('organizations').deleteMany({ _id: { $in: Object.values(orgs) } });
    for (const name of ['users', 'plivo_calls', 'call_sessions', 'email_sent_items', 'email_intelligence_items', 'email_follow_up_reminders', 'customer_tasks', 'crm_deals', 'crm_deal_owner_mappings', 'crm_activities']) {
      await connection.collection(name).deleteMany({ organizationId: { $in: ids } });
    }
    await connection.close();
  });

  const repFigures = {
    dealsCreated: 2,
    dealsWon: 1,
    dealsLost: 0,
    wonValue: 300,
    openDeals: 1,
    pipelineValue: 100,
    emailsSent: 2,
    emailsReceived: 2,
    emailsReplied: 2,
    emailsNotReplied: 1,
    emailsMissed: 1,
    customerReplies: 1,
    awaitingCustomer: 1,
    calls: 3,
    callsMade: 2,
    callsReceived: 0,
    callsConnected: 2,
    callsMissed: 1,
    talkSeconds: 900,
    avgCallSeconds: 450,
    scoredCalls: 2,
    avgCallScore: 7,
    followUpsCompleted: 2,
    followUpsPending: 2,
    followUpsOverdue: 1,
  };

  describe('whose work the caller sees', () => {
    it('the Main Account owner: the Main Account and every sub-account — never another company', async () => {
      const scope = await scopes.resolve(caller('mainOwner', org('main'), ['owner']));
      expect(scope.businesses.map((b) => b.name)).toEqual(['jest-team Main', 'jest-team Branch']);
      expect(scope).toMatchObject({ team: true, acrossBusinesses: true });
      expect(() => scopes.pick(scope, org('other'))).toThrow(ForbiddenException);
    });

    it('the Main Account owner switched into a sub-account: that business only', async () => {
      const scope = await scopes.resolve(caller('mainOwnerInSub', org('sub'), ['admin'], { loginUserId: who('mainOwner') }));
      expect(scope.businesses.map((b) => b.name)).toEqual(['jest-team Branch']);
      expect(scope.team).toBe(true);
    });

    it('a sub-account admin: their own team', async () => {
      const scope = await scopes.resolve(caller('subAdmin', org('sub'), ['admin']));
      expect(scope).toMatchObject({ team: true, acrossBusinesses: false });
      expect(scope.businesses.map((b) => b.name)).toEqual(['jest-team Branch']);
    });

    it('a manager: the people of their store', async () => {
      const scope = await scopes.resolve(caller('subManager', org('sub'), ['manager'], { storeId: 'store-1' }));
      const list = await scopes.people(scope, scope.businesses[0]);
      expect(list.map((p) => p.name).sort()).toEqual(['Rep One', 'Store Manager']);
    });

    it('anyone else: only themselves', async () => {
      const scope = await scopes.resolve(caller('rep', org('sub'), ['agent_user']));
      expect(scope.team).toBe(false);
      expect((await scopes.people(scope, scope.businesses[0])).map((p) => p.name)).toEqual(['Rep One']);
    });

    it('who may open a call', async () => {
      expect(await scopes.canSee(caller('mainOwner', org('main'), ['owner']), org('sub'), who('rep'))).toBe(true);
      expect(await scopes.canSee(caller('subAdmin', org('sub'), ['admin']), org('sub'), who('rep'))).toBe(true);
      expect(await scopes.canSee(caller('subManager', org('sub'), ['manager'], { storeId: 'store-1' }), org('sub'), who('rep'))).toBe(true);
      expect(await scopes.canSee(caller('subManager', org('sub'), ['manager'], { storeId: 'store-1' }), org('sub'), who('rep2'))).toBe(false);
      expect(await scopes.canSee(caller('rep', org('sub'), ['agent_user']), org('sub'), who('rep2'))).toBe(false);
      expect(await scopes.canSee(caller('otherOwner', org('other'), ['owner']), org('sub'), who('rep'))).toBe(false);
      expect(await scopes.canSee(caller('subAdmin', org('sub'), ['admin']), org('other'), who('otherOwner'))).toBe(false);
    });
  });

  describe('the figures', () => {
    it('every person of every business, for the Main Account owner', async () => {
      const result = await activity.overview(caller('mainOwner', org('main'), ['owner']), { period: 'today' }, now);
      const byName = new Map(result.people.map((p) => [p.name, p]));
      expect(byName.get('Rep One')).toMatchObject({ ...repFigures, businessName: 'jest-team Branch', role: 'Team member' });
      expect(byName.get('Rep Two')).toMatchObject({ dealsCreated: 1, dealsLost: 1, openDeals: 1, pipelineValue: 200, calls: 1, callsConnected: 1, talkSeconds: 0, avgCallSeconds: null, scoredCalls: 0, avgCallScore: null });
      // Quiet staff are listed with zeros; the owner's own record in the sub-account, with nothing done there, is not.
      expect(byName.get('Branch Admin')).toMatchObject({ calls: 0, emailsSent: 0, dealsCreated: 0 });
      expect(result.people.filter((p) => p.name === 'Main Owner' && p.businessName === 'jest-team Branch')).toEqual([]);
      expect(byName.has('Other Owner')).toBe(false);
      expect(result.totals).toMatchObject({ calls: 4, callsConnected: 3, talkSeconds: 900, scoredCalls: 2, avgCallScore: 7, dealsCreated: 5, dealsWon: 1, dealsLost: 1, emailsSent: 2 });
      // Of the 4 customer emails owed a reply: 2 answered, 1 waiting, 1 missed. Follow-ups: 2 done of 4.
      expect(result.summary).toMatchObject({ responseRatePct: 50, followUpCompletionPct: 50, activeEmployees: 2, currency: 'INR' });
      const branch = result.businesses.find((b) => b.name === 'jest-team Branch')!;
      expect(branch.totals).toMatchObject({ calls: 4, dealsCreated: 5 });
      expect(branch.activeEmployees).toBe(2);
      expect(result.unattributedDeals).toEqual({
        total: 2,
        byCrmOwner: expect.arrayContaining([
          { label: 'Enquiry T.nagar', shared: true, count: 1 },
          { label: 'Tom Renshaw', shared: false, count: 1 },
        ]),
      });
    });

    it('one person', async () => {
      const result = await activity.overview(caller('subAdmin', org('sub'), ['admin']), { period: 'today', userId: who('rep') }, now);
      expect(result.people.map((p) => p.name)).toEqual(['Rep One']);
      expect(result.totals).toMatchObject(repFigures);
      expect(result.unattributedDeals.total).toBe(0);
    });

    it('a team member sees only their own figures, nothing credited to nobody', async () => {
      const result = await activity.overview(caller('rep', org('sub'), ['agent_user']), { period: 'today' }, now);
      expect(result.team).toBe(false);
      expect(result.people.map((p) => p.name)).toEqual(['Rep One']);
      expect(result.totals.dealsCreated).toBe(2);
      expect(result.unattributedDeals.total).toBe(0);
    });

    it('a wider period takes in yesterday', async () => {
      const result = await activity.overview(caller('subAdmin', org('sub'), ['admin']), { period: 'last7', userId: who('rep') }, now);
      expect(result.totals).toMatchObject({ dealsCreated: 3, emailsSent: 3, calls: 4, talkSeconds: 1020 });
    });
  });

  describe('the records behind a number', () => {
    it('calls: phone calls with their recording’s score, and Call Copilot calls that are not a phone call’s recording', async () => {
      const result = await activity.list(caller('mainOwner', org('main'), ['owner']), 'calls', { period: 'today', userId: who('rep') }, now);
      expect(result.items.map((c) => [c.kind, c.connected, c.score, c.durationSeconds])).toEqual([
        ['phone', false, undefined, 0],
        ['phone', true, 8, 300],
        ['live', true, 6, 600],
      ]);
      expect(result.items[1]).toMatchObject({ sessionId: sessions.phoneRecording.toString(), headline: 'Acme pricing call', personName: 'Rep One', businessName: 'jest-team Branch' });
    });

    it('deals created: an admin sees those credited to nobody too, with the CRM salesperson', async () => {
      const team = await activity.list(caller('subAdmin', org('sub'), ['admin']), 'deals_created', { period: 'today' }, now);
      expect(team.items.map((d) => [d.name, d.personName ?? d.crmOwner])).toEqual([
        ['D5', 'Tom Renshaw'],
        ['D4', 'Enquiry T.nagar'],
        ['D3', 'Rep One'],
        ['D2', 'Rep Two'],
        ['D1', 'Rep One'],
      ]);
      const mine = await activity.list(caller('rep', org('sub'), ['agent_user']), 'deals_created', { period: 'today' }, now);
      expect(mine.items.map((d) => d.name)).toEqual(['D3', 'D1']);
    });

    it('emails sent, waiting and missed', async () => {
      const admin = caller('subAdmin', org('sub'), ['admin']);
      const sent = await activity.list(admin, 'emails_sent', { period: 'today', userId: who('rep') }, now);
      expect(sent.items.map((e) => [e.subject, e.isReply])).toEqual([
        ['Intro', false],
        ['Quote', true],
      ]);
      expect((await activity.list(admin, 'emails_not_replied', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['waiting']);
      expect((await activity.list(admin, 'emails_missed', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['missed']);
      expect((await activity.list(admin, 'emails_replied', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['asked', 'answered']);
    });

    it('deals won and lost, open pipeline, follow-ups, and calls by kind', async () => {
      const admin = caller('subAdmin', org('sub'), ['admin']);
      expect((await activity.list(admin, 'deals_won', { period: 'today' }, now)).items.map((d) => [d.name, d.personName, d.value])).toEqual([['D3', 'Rep One', 300]]);
      expect((await activity.list(admin, 'deals_lost', { period: 'today' }, now)).items.map((d) => [d.name, d.personName])).toEqual([['D7', 'Rep Two']]);
      expect((await activity.list(admin, 'pipeline', { period: 'today' }, now)).items.map((d) => [d.name, d.personName])).toEqual([
        ['D2', 'Rep Two'],
        ['D1', 'Rep One'],
      ]);
      const followUps = await activity.list(admin, 'follow_ups', { period: 'today', userId: who('rep') }, now);
      expect(followUps.items.map((f) => [f.title, f.status, f.overdue])).toEqual([
        ['Chase Acme', 'pending', true],
        ['Call Gamma back', 'pending', false],
        ['Quote Delta', 'done', false],
        ['Send Beta the sample', 'done', false],
      ]);
      expect((await activity.list(admin, 'calls', { period: 'today', userId: who('rep'), callFilter: 'missed' }, now)).items).toHaveLength(1);
      expect((await activity.list(admin, 'calls', { period: 'today', userId: who('rep'), callFilter: 'made' }, now)).items).toHaveLength(2);
      expect((await activity.list(admin, 'emails_customer_replies', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['answered']);
      expect((await activity.list(admin, 'emails_awaiting_customer', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['asked']);
    });

    it('trend: every day of the range, with the day each thing happened', async () => {
      const trend = await activity.trend(caller('subAdmin', org('sub'), ['admin']), { period: 'last7', userId: who('rep') }, now);
      expect(trend.granularity).toBe('day');
      expect(trend.points.map((p) => p.date)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
      const today = trend.points.find((p) => p.date === '2026-11-12')!;
      const yesterday = trend.points.find((p) => p.date === '2026-11-11')!;
      expect(today).toMatchObject({ calls: 3, talkSeconds: 900, emailsSent: 2, emailsReplied: 2, dealsCreated: 2, dealsWon: 1 });
      expect(yesterday).toMatchObject({ calls: 1, talkSeconds: 120, emailsSent: 1, dealsCreated: 1 });
    });

    it('never another business’s records', async () => {
      await expect(activity.list(caller('subAdmin', org('sub'), ['admin']), 'calls', { period: 'today', organizationId: org('other') }, now)).rejects.toThrow(ForbiddenException);
      const other = await activity.list(caller('otherOwner', org('other'), ['owner']), 'calls', { period: 'today' }, now);
      expect(other.items.every((c) => c.businessName === 'jest-team Other')).toBe(true);
    });
  });
});
