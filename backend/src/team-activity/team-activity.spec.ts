import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { EmailFollowUpReminder, EmailFollowUpReminderSchema } from '../email-intelligence/schemas/email-follow-up-reminder.schema';
import { EmployeeUsageService } from '../employee-usage/employee-usage.service';
import { EmployeeSignIn, EmployeeSignInSchema } from '../employee-usage/schemas/employee-sign-in.schema';
import { EmployeeUsageHour, EmployeeUsageHourSchema } from '../employee-usage/schemas/employee-usage-hour.schema';
import { TeamActivityService } from './team-activity.service';
import { periodDays, periodRange, previousDays } from './team-period';
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

  it('"This week" runs from Monday to today, in each business’s own week', () => {
    // Thursday the 12th in India; already Friday the 13th in Sydney.
    expect(periodDays('week', 'Asia/Kolkata', now)).toEqual({ from: '2026-11-09', to: '2026-11-12' });
    expect(periodDays('week', 'Australia/Sydney', now)).toEqual({ from: '2026-11-09', to: '2026-11-13' });
    // On a Monday the week is that one day; on a Sunday, the six days before it too.
    expect(periodDays('week', 'Asia/Kolkata', new Date('2026-11-09T06:00:00Z'))).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(periodDays('week', 'Asia/Kolkata', new Date('2026-11-15T06:00:00Z'))).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('compares with the period before: yesterday, the same weekdays last week, the same days last month', () => {
    expect(previousDays('today', { from: '2026-11-12', to: '2026-11-12' })).toEqual({ from: '2026-11-11', to: '2026-11-11' });
    expect(previousDays('week', { from: '2026-11-09', to: '2026-11-12' })).toEqual({ from: '2026-11-02', to: '2026-11-05' });
    expect(previousDays('month', { from: '2026-11-01', to: '2026-11-12' })).toEqual({ from: '2026-10-01', to: '2026-10-12' });
    expect(previousDays('month', { from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(previousDays('previous_month', { from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousDays('custom', { from: '2026-11-01', to: '2026-11-05' })).toEqual({ from: '2026-10-27', to: '2026-10-31' });
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
  let usage: EmployeeUsageService;

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
          { name: EmployeeUsageHour.name, schema: EmployeeUsageHourSchema },
          { name: EmployeeSignIn.name, schema: EmployeeSignInSchema },
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
    usage = new EmployeeUsageService(moduleRef.get(getModelToken(EmployeeUsageHour.name)), moduleRef.get(getModelToken(EmployeeSignIn.name)), connection);
    activity = new TeamActivityService(connection, scopes, emails, undefined, usage);

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
    for (const name of [
      'users',
      'plivo_calls',
      'call_sessions',
      'email_sent_items',
      'email_intelligence_items',
      'email_follow_up_reminders',
      'customer_tasks',
      'crm_deals',
      'crm_deal_owner_mappings',
      'crm_activities',
      'employee_usage_hours',
      'employee_sign_ins',
    ]) {
      await connection.collection(name).deleteMany({ organizationId: { $in: ids } });
    }
    await connection.close();
  });

  const repFigures = {
    dealsCreated: 2,
    dealsWon: 1,
    dealsLost: 0,
    wonValue: 300,
    dealConversionPct: 100,
    openDeals: 1,
    pipelineValue: 100,
    emailsSent: 2,
    emailsReceived: 2,
    emailsReplied: 2,
    emailsNotReplied: 1,
    emailsMissed: 1,
    // Only "waiting" arrived today and is still owed ("missed" arrived yesterday).
    emailsUnanswered: 1,
    // "answered" waited 1 hour (replied in HaiVE); "asked" 19.5 hours (replied in Outlook).
    avgResponseSeconds: (3600 + 70200) / 2,
    customerReplies: 1,
    awaitingCustomer: 1,
    calls: 3,
    callsMade: 2,
    callsReceived: 0,
    callsConnected: 2,
    // The call nobody picked up was outgoing: unanswered, not missed.
    callsMissed: 0,
    callsUnanswered: 1,
    callConnectionRatePct: 50,
    callAnswerRatePct: null,
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

    it('with the period before, to compare', async () => {
      const result = await activity.overview(caller('subAdmin', org('sub'), ['admin']), { period: 'today', userId: who('rep'), compare: true }, now);
      expect(result.previous).toMatchObject({ from: '2026-11-11', to: '2026-11-11', totals: { calls: 1, talkSeconds: 120, dealsCreated: 1, emailsSent: 1 } });
      expect((await activity.overview(caller('subAdmin', org('sub'), ['admin']), { period: 'today' }, now)).previous).toBeUndefined();
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
      expect((await activity.list(admin, 'calls', { period: 'today', userId: who('rep'), callFilter: 'missed' }, now)).items).toHaveLength(0);
      expect((await activity.list(admin, 'calls', { period: 'today', userId: who('rep'), callFilter: 'unanswered' }, now)).items).toHaveLength(1);
      expect((await activity.list(admin, 'emails_unanswered', { period: 'today' }, now)).items.map((e) => e.subject)).toEqual(['waiting']);
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
      expect(today).toMatchObject({ calls: 3, callsMade: 2, callsUnanswered: 1, callsMissed: 0, talkSeconds: 900, emailsSent: 2, emailsReplied: 2, emailsReceived: 2, dealsCreated: 2, dealsWon: 1, wonValue: 300 });
      // Time on calls is measured time too: the 10-minute live call and the 5-minute phone call.
      expect(today).toMatchObject({ activeSeconds: 900, haiveSeconds: 0, activePeople: 1 });
      expect(yesterday).toMatchObject({ calls: 1, talkSeconds: 120, emailsSent: 1, dealsCreated: 1 });
    });

    it('never another business’s records', async () => {
      await expect(activity.list(caller('subAdmin', org('sub'), ['admin']), 'calls', { period: 'today', organizationId: org('other') }, now)).rejects.toThrow(ForbiddenException);
      const other = await activity.list(caller('otherOwner', org('other'), ['owner']), 'calls', { period: 'today' }, now);
      expect(other.items.every((c) => c.businessName === 'jest-team Other')).toBe(true);
    });
  });

  // Employee monitoring: tasks given to people (one task system — customer_tasks),
  // moved along by the person or their manager, and who may need support.
  describe('tasks given, moved along, and who may need support', () => {
    const admin = () => caller('subAdmin', org('sub'), ['admin']);
    const manager = () => caller('subManager', org('sub'), ['manager'], { storeId: 'store-1' });
    const rep = () => caller('rep', org('sub'), ['agent_user']);
    const rep2 = () => caller('rep2', org('sub'), ['consultant']);
    const mainOwner = () => caller('mainOwner', org('main'), ['owner']);

    afterAll(async () => {
      await connection.collection('customer_tasks').deleteMany({ organizationId: org('sub'), source: 'team' });
      await connection.collection('users').updateOne({ _id: people.rep }, { $unset: { department: '' } });
    });

    it('says who may need support, and why, in a line each', async () => {
      const today = await activity.overview(mainOwner(), { period: 'today' }, now);
      const lines = today.attention.map((a) => `${a.personName}: ${a.text}`);
      expect(lines).toEqual(expect.arrayContaining(['Rep One: 1 task past the day it was due.', 'Rep One: 1 customer email went 24 hours without a reply.']));
      expect(today.attention.find((a) => a.text.includes('without a reply'))).toMatchObject({ list: 'emails_missed', businessName: 'jest-team Branch', severity: 'warning' });
      // "Today" may have barely begun: nobody is flagged for doing nothing yet.
      expect(lines.some((l) => l.includes('Nothing recorded'))).toBe(false);
      // Over a week, the branch admin did nothing at all.
      const week = await activity.overview(mainOwner(), { period: 'last7' }, now);
      expect(week.attention.map((a) => `${a.personName}: ${a.text}`)).toContain('Branch Admin: Nothing recorded in this period — no time in HaiVE, calls, emails, deals or finished tasks.');
      // The Main Account owner's own record in the sub-account is never among them.
      expect(week.attention.some((a) => a.personName === 'Main Owner')).toBe(false);
      // Only for someone who sees the team.
      expect((await activity.overview(rep(), { period: 'today' }, now)).attention).toEqual([]);
    });

    it('a manager gives a task; the person starts it and finishes it', async () => {
      const given = await activity.giveTask(admin(), { assigneeId: who('rep2'), title: 'Call back the Diwali leads', dueDate: '2026-11-14', priority: 'high' }, now);
      expect(given).toMatchObject({ title: 'Call back the Diwali leads', status: 'pending', inProgress: false, priority: 'high', origin: 'team', givenBy: 'Branch Admin', personName: 'Rep Two' });
      expect((await activity.myTasks(rep2(), now)).items.map((t) => t.title)).toContain('Call back the Diwali leads');

      const started = await activity.moveTask(rep2(), given.id, { status: 'in_progress' }, now);
      expect(started).toMatchObject({ status: 'pending', inProgress: true });
      expect((await activity.overview(admin(), { period: 'today', userId: who('rep2') }, now)).totals).toMatchObject({ followUpsPending: 1, followUpsInProgress: 1, followUpsOverdue: 0 });

      // The day it is due is their manager's to change, not theirs.
      await expect(activity.moveTask(rep2(), given.id, { dueDate: '2026-11-20' }, now)).rejects.toThrow(ForbiddenException);
      expect((await activity.moveTask(admin(), given.id, { dueDate: '2026-11-10' }, now)).overdue).toBe(true);

      expect(await activity.moveTask(rep2(), given.id, { status: 'done' }, now)).toMatchObject({ status: 'done', inProgress: false, overdue: false });
      expect((await activity.overview(admin(), { period: 'today', userId: who('rep2') }, now)).totals).toMatchObject({ followUpsCompleted: 1, followUpsPending: 0, followUpsInProgress: 0 });
      // Back to "to do" forgets that it was started.
      expect(await activity.moveTask(admin(), given.id, { status: 'todo' }, now)).toMatchObject({ status: 'pending', inProgress: false });
    });

    it('only someone who sees that person may give or move their tasks', async () => {
      // A team member gives no tasks; a manager only to the people of their store; another company never.
      await expect(activity.giveTask(rep(), { assigneeId: who('rep2'), title: 'x' }, now)).rejects.toThrow(ForbiddenException);
      await expect(activity.giveTask(manager(), { assigneeId: who('rep2'), title: 'x' }, now)).rejects.toThrow(ForbiddenException);
      await expect(activity.giveTask(caller('otherOwner', org('other'), ['owner']), { organizationId: org('sub'), assigneeId: who('rep'), title: 'x' }, now)).rejects.toThrow(ForbiddenException);
      await expect(activity.giveTask(admin(), { assigneeId: who('rep'), title: '   ' }, now)).rejects.toThrow(BadRequestException);

      const forRep = await activity.giveTask(manager(), { assigneeId: who('rep'), title: 'Send the catalogue' }, now);
      // A colleague can't move it, another company can't even find it; the person can.
      await expect(activity.moveTask(rep2(), forRep.id, { status: 'done' }, now)).rejects.toThrow(ForbiddenException);
      await expect(activity.moveTask(caller('otherOwner', org('other'), ['owner']), forRep.id, { status: 'done' }, now)).rejects.toThrow(NotFoundException);
      expect((await activity.moveTask(rep(), forRep.id, { status: 'in_progress' }, now)).inProgress).toBe(true);
    });

    it('the Main Account owner gives a task in a sub-account, signed as their own record there', async () => {
      const given = await activity.giveTask(mainOwner(), { organizationId: org('sub'), assigneeId: who('rep2'), title: 'Visit the Velachery client' }, now);
      const stored = await connection.collection('customer_tasks').findOne({ _id: new Types.ObjectId(given.id) });
      expect(stored).toMatchObject({ organizationId: org('sub'), createdBy: who('mainOwnerInSub'), source: 'team', customerKeys: [], assigneeId: who('rep2') });
    });

    it('a person’s own list: in progress first, then what is waiting, then what they finished this week', async () => {
      const mine = await activity.myTasks(rep(), now);
      expect(mine.items.map((t) => [t.title, t.status, t.inProgress])).toEqual([
        ['Send the catalogue', 'pending', true],
        ['Call Gamma back', 'pending', false],
        ['Quote Delta', 'done', false],
      ]);
      expect(mine).toMatchObject({ open: 2, inProgress: 1, overdue: 0 });
      // Every one of them is theirs to move along.
      expect(mine.items.every((t) => t.editable)).toBe(true);
    });

    it('departments: each team of each business added up, once anyone has one', async () => {
      expect((await activity.overview(admin(), { period: 'today' }, now)).departments).toEqual([]);
      await connection.collection('users').updateOne({ _id: people.rep }, { $set: { department: 'Sales' } });
      const result = await activity.overview(admin(), { period: 'today' }, now);
      expect(result.departments.map((d) => d.name)).toEqual(['Sales', 'No department']);
      expect(result.departments[0]).toMatchObject({ people: 1, businessName: 'jest-team Branch', calls: 3, emailsMissed: 1, needSupport: 1 });
      expect(result.people.find((p) => p.name === 'Rep One')!.department).toBe('Sales');
    });
  });

  // Employee Activity's measured time: HaiVE in active use (sent by the browser) and
  // calls, a minute counted once; sign-ins; and the App usage report.
  describe('measured time, sign-ins and app usage', () => {
    const session = (key: keyof typeof people, organizationId: string, roles: string[]) => caller(key, organizationId, roles, { authMethod: 'session' });
    const admin = () => caller('subAdmin', org('sub'), ['admin']);
    const hourDoc = (userId: string, hour: string) => connection.collection('employee_usage_hours').findOne({ organizationId: org('sub'), userId, hour: at(hour) });

    beforeAll(async () => {
      // Rep One: 11:30–11:32 in India in the CRM and the inbox (two tabs: 45 + 30 seconds in one minute),
      // the inbox again at 12:00, and 20 seconds in Call Copilot during their phone call.
      await usage.record(
        session('rep', org('sub'), ['agent_user']),
        {
          sentAt: now.toISOString(),
          beats: [
            { minute: '2026-11-12T06:00:00Z', area: 'crm', seconds: 45 },
            { minute: '2026-11-12T06:00:00Z', area: 'email', seconds: 30 },
            { minute: '2026-11-12T06:01:00Z', area: 'crm', seconds: 40 },
            { minute: '2026-11-12T06:30:00Z', area: 'email', seconds: 60 },
            { minute: '2026-11-12T09:02:00Z', area: 'calls', seconds: 20 },
          ],
        },
        now,
      );
    });

    it('stores only real, signed-in, sensible minutes', async () => {
      const rep = session('rep', org('sub'), ['agent_user']);
      // An API token or a service never records anyone's time.
      expect(await usage.record(caller('rep', org('sub'), ['agent_user']), { beats: [{ minute: '2026-11-12T07:00:00Z', area: 'crm', seconds: 30 }] }, now)).toEqual({ recorded: 0 });
      expect(await usage.record(caller('rep', org('sub'), ['agent_user'], { authMethod: 'api_token' }), { beats: [{ minute: '2026-11-12T07:00:00Z', area: 'crm', seconds: 30 }] }, now)).toEqual({ recorded: 0 });
      // In the future, over a day old, an unknown part of the app, nothing measured: dropped.
      const dropped = await usage.record(
        rep,
        {
          sentAt: now.toISOString(),
          beats: [
            { minute: '2026-11-12T10:05:00Z', area: 'crm', seconds: 30 },
            { minute: '2026-11-10T06:00:00Z', area: 'crm', seconds: 30 },
            { minute: '2026-11-12T06:02:00Z', area: 'games', seconds: 30 },
            { minute: '2026-11-12T06:03:00Z', area: 'crm', seconds: 0 },
          ],
        },
        now,
      );
      expect(dropped).toEqual({ recorded: 0 });
      // Sent again, and a lower running total for a minute already stored: nothing doubles or shrinks.
      await usage.record(rep, { sentAt: now.toISOString(), beats: [{ minute: '2026-11-12T06:00:00Z', area: 'crm', seconds: 10 }, { minute: '2026-11-12T06:01:00Z', area: 'crm', seconds: 40 }] }, now);
      const stored = await hourDoc(who('rep'), '2026-11-12T06:00:00Z');
      expect(stored!.m).toEqual({ '00': { crm: 45, email: 30 }, '01': { crm: 40 }, '30': { email: 60 } });
      expect(stored!.firstAt).toEqual(at('2026-11-12T06:00:00Z'));
      expect(stored!.lastAt).toEqual(at('2026-11-12T06:31:00Z'));
    });

    it('corrects a browser clock that is off', async () => {
      // The browser's clock reads 9:57 when the server's reads 10:00: its 9:50 was really 9:53.
      await usage.record(session('rep2', org('sub'), ['consultant']), { sentAt: '2026-11-12T09:57:00Z', beats: [{ minute: '2026-11-12T09:50:00Z', area: 'tasks', seconds: 30 }] }, now);
      expect((await hourDoc(who('rep2'), '2026-11-12T09:00:00Z'))!.m).toEqual({ '53': { tasks: 30 } });
    });

    it('measures each day: HaiVE and calls, a minute counted once, in work sessions', async () => {
      const report = await activity.usage(admin(), { period: 'today', userId: who('rep') }, now);
      // HaiVE: 60 (two tabs capped) + 40 + 60 + 20. Calls: 300 (phone) + 600 (live).
      // Active: 60 + 40 + 60 + 600 + 300 (the minute in Call Copilot during the phone call counts once).
      expect(report.totals).toMatchObject({ activeSeconds: 1060, haiveSeconds: 180, callSeconds: 900, activePeople: 1, avgActiveSecondsPerPersonDay: 1060 });
      // The capped minute is shared out between the two parts in proportion (45:30 → 36:24).
      expect(report.areas).toEqual([
        { key: 'email', label: 'Email inbox', seconds: 84 },
        { key: 'crm', label: 'CRM & customers', seconds: 76 },
        { key: 'calls', label: 'Call Copilot', seconds: 20 },
      ]);
      const day = report.person!.days[0];
      expect(day).toMatchObject({ date: '2026-11-12', activeSeconds: 1060, firstAt: at('2026-11-12T06:00:00Z'), lastAt: at('2026-11-12T09:06:00Z') });
      // A break of more than 15 minutes starts a new session.
      expect(day.sessions.map((s) => [s.start.toISOString(), s.end.toISOString(), s.activeSeconds])).toEqual([
        ['2026-11-12T06:00:00.000Z', '2026-11-12T06:02:00.000Z', 100],
        ['2026-11-12T06:30:00.000Z', '2026-11-12T06:31:00.000Z', 60],
        ['2026-11-12T08:00:00.000Z', '2026-11-12T08:10:00.000Z', 600],
        ['2026-11-12T09:00:00.000Z', '2026-11-12T09:06:00.000Z', 300],
      ]);
      expect(report.people).toEqual([expect.objectContaining({ name: 'Rep One', activeDays: 1, topArea: 'email', lastActiveAt: at('2026-11-12T09:03:00Z') })]);
      // Every day of the period is in the series (here, one).
      expect(report.days).toEqual([expect.objectContaining({ date: '2026-11-12', activeSeconds: 1060, activePeople: 1 })]);
    });

    it('puts measured time in the figures, with when each person was last active', async () => {
      const result = await activity.overview(admin(), { period: 'today' }, now);
      const rep = result.people.find((p) => p.name === 'Rep One')!;
      expect(rep).toMatchObject({ activeSeconds: 1060, haiveSeconds: 180, lastActiveAt: at('2026-11-12T09:03:00Z') });
      expect(result.people.find((p) => p.name === 'Rep Two')).toMatchObject({ activeSeconds: 30, haiveSeconds: 30 });
      expect(result.totals.activeSeconds).toBe(1090);
      // Calls and app usage are recorded as they happen; Outlook isn't connected here.
      expect(result.sources.map((s) => [s.key, s.mode, s.status])).toEqual([
        ['calls', 'real_time', 'ok'],
        ['usage', 'real_time', 'ok'],
        ['email', 'on_open', 'not_connected'],
      ]);
    });

    it('says what can be known about each app: time, activity only, or nothing', async () => {
      const report = await activity.usage(admin(), { period: 'today' }, now);
      const app = (key: string) => report.apps.find((a) => a.key === key)!;
      expect(app('haive')).toMatchObject({ measure: 'time', seconds: 210 });
      expect(app('calls')).toMatchObject({ measure: 'time', seconds: 900 });
      expect(app('outlook')).toMatchObject({
        measure: 'activity',
        connected: false,
        activity: [
          { label: 'Emails sent', count: 2 },
          { label: 'Replies written in Outlook', count: 1 },
          { label: 'Replies written in HaiVE', count: 1 },
        ],
      });
      expect(app('pos')).toMatchObject({ measure: 'none', connected: false });
      expect(app('gmail')).toMatchObject({ measure: 'none', connected: false });
      expect(report.measuredSince).toEqual(at('2026-11-12T06:00:00Z'));
    });

    it('sign-ins: logged ones with their sign-out, and sessions still open', async () => {
      await usage.logSignIn({ organizationId: org('sub'), userId: who('rep'), kind: 'sign_in', jti: 'jest-j1', device: 'Chrome on Windows' }, at('2026-11-12T05:00:00Z'));
      await usage.logSignIn({ organizationId: org('sub'), userId: who('rep'), kind: 'sign_out', jti: 'jest-j1' }, at('2026-11-12T07:00:00Z'));
      await usage.logSignIn({ organizationId: org('sub'), userId: who('rep'), kind: 'sign_in', jti: 'jest-j2', device: 'Chrome on Windows' }, at('2026-11-12T08:00:00Z'));
      // j2 is still open; j3 was opened before the log existed and is still open too.
      await connection.collection('users').updateOne(
        { _id: people.rep },
        {
          $set: {
            sessions: [
              { jti: 'jest-j2', device: 'Chrome on Windows', createdAt: at('2026-11-12T08:00:00Z'), lastSeenAt: at('2026-11-12T09:00:00Z') },
              { jti: 'jest-j3', device: 'Safari on iPhone', createdAt: at('2026-11-12T09:30:00Z'), lastSeenAt: at('2026-11-12T09:40:00Z') },
            ],
          },
        },
      );
      const report = await activity.usage(admin(), { period: 'today', userId: who('rep') }, now);
      expect(report.person!.signIns.map((s) => [s.at.toISOString(), s.device, s.open, s.signedOutAt?.toISOString()])).toEqual([
        ['2026-11-12T09:30:00.000Z', 'Safari on iPhone', true, undefined],
        ['2026-11-12T08:00:00.000Z', 'Chrome on Windows', true, undefined],
        ['2026-11-12T05:00:00.000Z', 'Chrome on Windows', false, '2026-11-12T07:00:00.000Z'],
      ]);
      await connection.collection('users').updateOne({ _id: people.rep }, { $unset: { sessions: '' } });
    });

    it('never shows anyone outside the caller’s view', async () => {
      // Another company's time never reaches this business.
      await usage.record(session('otherOwner', org('other'), ['owner']), { sentAt: now.toISOString(), beats: [{ minute: '2026-11-12T06:00:00Z', area: 'crm', seconds: 60 }] }, now);
      const team = await activity.usage(admin(), { period: 'today' }, now);
      expect(team.people.map((p) => p.name)).not.toContain('Other Owner');
      await expect(activity.usage(admin(), { period: 'today', organizationId: org('other') }, now)).rejects.toThrow(ForbiddenException);
      // A team member sees only their own, and no one's sign-ins but theirs.
      const mine = await activity.usage(caller('rep', org('sub'), ['agent_user']), { period: 'today' }, now);
      expect(mine.people.map((p) => p.name)).toEqual(['Rep One']);
      const theirs = await activity.usage(caller('rep', org('sub'), ['agent_user']), { period: 'today', userId: who('rep2') }, now);
      expect(theirs.people).toEqual([]);
      expect(theirs.person).toBeUndefined();
    });
  });
});
