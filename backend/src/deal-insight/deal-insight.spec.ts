import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { of, throwError } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { DealBrief, DealInsightService, readableStage } from './deal-insight.service';
import { HEALTH_WEIGHTS, dealHealth } from './deal-health';

// Against a real Mongo: the deal panel gathers one deal's quotations, CRM
// notes, emails (by the customer's address and company domain), calls and
// history; only people who may see the deal can open it; the AI brief is
// billed, kept, and marked out of date when something new arrives.
describe('deal insight (real Mongo)', () => {
  let connection: Connection;
  let service: DealInsightService;
  const httpPost = jest.fn();
  const notifications = { create: jest.fn(async () => ({})) };
  const audit = { log: jest.fn(async () => undefined) };
  const reservations = {
    resolveTenantKey: (org: string) => org,
    reserve: jest.fn(async () => ({})),
    settle: jest.fn(async () => ({})),
    release: jest.fn(async () => ({ released: true })),
  };

  const id = () => new Types.ObjectId();
  const orgs = { main: id(), sub: id(), other: id() };
  const org = (key: keyof typeof orgs) => orgs[key].toString();
  const people = { mainOwner: id(), subAdmin: id(), owner: id(), colleague: id(), otherAdmin: id() };
  const who = (key: keyof typeof people) => people[key].toString();
  const dealId = id();
  const contactId = id();
  const sessionId = id();
  const caller = (key: keyof typeof people, organizationId: string, roles: string[]): JwtPayload =>
    ({ sub: who(key), organizationId, roles, email: `${key}@example.com` }) as JwtPayload;

  const brief: DealBrief = {
    statusLabel: 'Quote sent - awaiting reply',
    leadStatus: 'awaiting_response',
    leadStatusReason: 'The customer asked for a sample and we have not replied.',
    observedFacts: ['Quote Q-101 sent on 5 Nov', 'Ravi asked for a navy sample on 10 Nov'],
    inferences: ['Interested, deciding on colour'],
    emailSummary: 'Quote sent; customer asked for a navy sample.',
    emailInsights: { questions: ['Can we see a navy sample?'], commitments: [], pricing: [], objections: [], competitors: [] },
    crmOverview: 'One quotation, one note asking for navy.',
    recommendations: [{ action: 'Send the navy sample photo', why: 'It is what they asked for', urgency: 'today' }],
    nextBestAction: { action: 'Reply to Ravi with a navy sample', why: 'His question is unanswered', urgency: 'today', deadline: 'Today' },
    health: 'needs_attention',
    winLikelihood: 'medium',
    winLikelihoodReason: 'Interested, but the last email is unanswered.',
    summary: 'Acme wants 200 branded shirts.',
    lastContact: 'Acme emailed 2 days ago.',
    waitingOn: 'us',
    customerNeeds: ['200 shirts'],
    risks: ['Unanswered email'],
    nextAction: 'Reply to Acme today.',
    plan: [{ step: 'Reply with the revised quote', owner: 'salesperson', when: 'Today' }],
    missingInfo: [],
    suggestedMessage: 'Hi Asha, …',
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    service = new DealInsightService(
      connection,
      new TeamScopeService(connection),
      reservations as never,
      { post: httpPost } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      notifications as never,
      audit as never,
    );
    const db = connection;
    await db.collection('organizations').insertMany([
      { _id: orgs.main, slug: `jest-deal-${orgs.main}`, name: 'jest-deal Main', timezone: 'Asia/Kolkata', currency: 'INR' },
      { _id: orgs.sub, slug: `jest-deal-${orgs.sub}`, name: 'jest-deal Branch', timezone: 'Australia/Sydney', currency: 'AUD', parentOrganizationId: org('main') },
      { _id: orgs.other, slug: `jest-deal-${orgs.other}`, name: 'jest-deal Other', timezone: 'Asia/Kolkata' },
    ]);
    await db.collection('users').insertMany([
      { _id: people.mainOwner, organizationId: org('main'), name: 'Main Owner', roles: ['owner'] },
      { _id: people.subAdmin, organizationId: org('sub'), name: 'Branch Admin', roles: ['admin'] },
      { _id: people.owner, organizationId: org('sub'), name: 'Deal Owner', roles: ['consultant'] },
      { _id: people.colleague, organizationId: org('sub'), name: 'Colleague', roles: ['consultant'] },
      { _id: people.otherAdmin, organizationId: org('other'), name: 'Other Admin', roles: ['admin'] },
    ]);
    await db.collection('crm_contacts').insertOne({ _id: contactId, organizationId: org('sub'), name: 'Asha Rao', email: 'asha@acme.com.au', phone: '+61 400 111 222', tags: [] });
    await db.collection('crm_deals').insertOne({
      _id: dealId,
      organizationId: org('sub'),
      name: 'Acme shirts',
      dealStatus: 'open',
      monetaryValue: 4200,
      expectedClosingDate: '2026-11-30',
      ownerId: who('owner'),
      contactId: contactId.toString(),
    });
    await db.collection('crm_quotes').insertOne({ organizationId: org('sub'), dealId: dealId.toString(), quoteNumber: 'Q-101', quoteStatus: 'sent', clientApprovalStatus: 'pending', quoteAmount: 4200, currency: 'AUD', createdAt: new Date('2026-11-05T00:00:00Z') });
    await db.collection('crm_notes').insertOne({ organizationId: org('sub'), contactId: contactId.toString(), dealId: dealId.toString(), body: 'Wants navy, not black.', createdBy: who('owner'), createdAt: new Date('2026-11-06T00:00:00Z') });
    await db.collection('email_intelligence_items').insertMany([
      // From a colleague of Asha's at the same company: matched by the domain.
      { organizationId: org('sub'), userId: who('owner'), mailboxEmail: 'owner@x.com', externalMessageId: `jest-deal-in-${dealId}`, receivedAt: new Date('2026-11-10T00:00:00Z'), subject: 'Navy sample?', fromAddress: 'ravi@acme.com.au', fromName: 'Ravi', bodyPreview: 'Can we see a navy sample?', reason: 'Asks for a sample', intent: 'existing_customer', expectedNextAction: 'company_reply', status: 'pending' },
      // Someone else entirely, on a free mail domain: never matched.
      { organizationId: org('sub'), userId: who('owner'), mailboxEmail: 'owner@x.com', externalMessageId: `jest-deal-noise-${dealId}`, receivedAt: new Date('2026-11-10T00:00:00Z'), subject: 'Unrelated', fromAddress: 'someone@gmail.com', bodyPreview: '', intent: 'new_enquiry', status: 'pending' },
    ]);
    await db.collection('email_sent_items').insertOne({ organizationId: org('sub'), userId: who('owner'), mailboxEmail: 'owner@x.com', externalMessageId: `jest-deal-out-${dealId}`, sentAt: new Date('2026-11-05T01:00:00Z'), subject: 'Your quote Q-101', toAddresses: ['asha@acme.com.au'], bodyPreview: 'Please find attached…' });
    await db.collection('call_sessions').insertOne({ _id: sessionId, organizationId: org('sub'), userId: who('owner'), source: 'upload', status: 'ended', headline: 'Pricing call', overallScore: 7.5, summaryPoints: ['Wants 200 shirts'], followUpActions: [{ text: 'Send navy sample', priority: 'high' }], creditRequestId: `jest-deal-${sessionId}`, transcript: [], createdAt: new Date('2026-11-04T02:00:00Z') });
    // Phoned on the contact's number, without the deal on the call: matched by the number.
    await db.collection('plivo_calls').insertOne({ organizationId: org('sub'), userId: who('owner'), direction: 'outbound', customerNumber: '+61400111222', status: 'completed', answeredAt: new Date('2026-11-04T01:00:30Z'), durationSeconds: 420, sessionId: sessionId.toString(), createdAt: new Date('2026-11-04T01:00:00Z') });
    await db.collection('crm_activities').insertOne({ organizationId: org('sub'), entity: 'deal', entityId: dealId.toString(), kind: 'created', actorUserId: who('owner'), byAi: false, origin: 'haive', occurredAt: new Date('2026-11-03T00:00:00Z'), occurredAtBasis: 'haive', dedupeKey: `jest-deal:${dealId}:created` });
    await db.collection('deal_assignment_history').insertOne({ organizationId: org('sub'), dealId: dealId.toString(), fromOwnerId: who('colleague'), toOwnerId: who('owner'), assignedBy: who('subAdmin'), reason: 'Colleague on leave', at: new Date('2026-11-04T00:00:00Z') });
  });

  afterAll(async () => {
    const ids = Object.values(orgs).map((o) => o.toString());
    await connection.collection('organizations').deleteMany({ _id: { $in: Object.values(orgs) } });
    for (const name of ['users', 'crm_contacts', 'crm_deals', 'crm_quotes', 'crm_notes', 'email_intelligence_items', 'email_sent_items', 'call_sessions', 'plivo_calls', 'crm_activities', 'deal_briefs', 'customer_tasks', 'deal_agent_actions', 'deal_assignment_history']) {
      await connection.collection(name).deleteMany({ organizationId: { $in: ids } });
    }
    await connection.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('gathers everything recorded about the deal, without any AI', async () => {
    const overview = await service.overview(caller('subAdmin', org('sub'), ['admin']), dealId.toString());
    expect(overview.deal).toMatchObject({ name: 'Acme shirts', value: 4200, currency: 'AUD', ownerName: 'Deal Owner', businessName: 'jest-deal Branch' });
    expect(overview.customer).toMatchObject({ name: 'Asha Rao', email: 'asha@acme.com.au' });
    expect(overview.quotes.map((q) => q.number)).toEqual(['Q-101']);
    expect(overview.notes.map((n) => [n.body, n.by])).toEqual([['Wants navy, not black.', 'Deal Owner']]);
    expect(overview.emails.map((e) => [e.direction, e.subject, e.waitingForReply])).toEqual([
      ['in', 'Navy sample?', true],
      ['out', 'Your quote Q-101', undefined],
    ]);
    expect(overview.calls).toEqual([
      expect.objectContaining({ kind: 'phone', connected: true, durationSeconds: 420, score: 7.5, headline: 'Pricing call', sessionId: sessionId.toString(), followUps: ['Send navy sample'] }),
    ]);
    expect(overview.history.map((h) => [h.kind, h.by])).toEqual([['created', 'Deal Owner']]);
    expect(overview.stats).toMatchObject({ emailsIn: 1, emailsOut: 1, waitingForReply: 1, calls: 1, notes: 1, quotes: 1 });
    expect(overview.brief).toBeNull();
    expect(overview.assignments).toEqual([{ at: new Date('2026-11-04T00:00:00Z'), from: 'Colleague', to: 'Deal Owner', by: 'Branch Admin', reason: 'Colleague on leave' }]);
    // Health is worked out from the records — the waiting email costs the whole "answered" share.
    expect(overview.health.factors.map((f) => f.key)).toEqual(['recency', 'responsiveness', 'engagement', 'progression', 'callQuality', 'timeliness']);
    expect(overview.health.factors.find((f) => f.key === 'responsiveness')!.points).toBe(0);
    expect(overview.health.factors.find((f) => f.key === 'progression')).toMatchObject({ points: 12, detail: 'A quotation has been sent, not yet accepted.' });
    expect(overview.health.risks).toContain('The customer is waiting for our reply.');
    expect(httpPost).not.toHaveBeenCalled();
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it('opens only for people who may see the deal', async () => {
    await expect(service.overview(caller('owner', org('sub'), ['consultant']), dealId.toString())).resolves.toBeTruthy();
    await expect(service.overview(caller('mainOwner', org('main'), ['owner']), dealId.toString())).resolves.toBeTruthy();
    await expect(service.overview(caller('colleague', org('sub'), ['consultant']), dealId.toString())).rejects.toThrow(ForbiddenException);
    await expect(service.overview(caller('otherAdmin', org('other'), ['admin']), dealId.toString())).rejects.toThrow(NotFoundException);
  });

  it('writes the brief on Analyse only, bills it, keeps it, and marks it out of date when something new arrives', async () => {
    httpPost.mockReturnValueOnce(of({ data: brief }));
    const admin = caller('subAdmin', org('sub'), ['admin']);
    const written = await service.analyse(admin, dealId.toString());
    expect(written).toMatchObject({ statusLabel: 'Quote sent - awaiting reply', stale: false });
    expect(reservations.reserve).toHaveBeenCalledTimes(1);
    expect(reservations.settle).toHaveBeenCalledTimes(1);
    const sent = httpPost.mock.calls[0][1];
    expect(sent).toMatchObject({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), business: { currency: 'AUD' } });
    expect(sent.emails.map((e: { direction: string }) => e.direction)).toEqual(['to customer', 'from customer']);

    expect((await service.overview(admin, dealId.toString())).brief).toMatchObject({ nextAction: 'Reply to Acme today.', stale: false });
    await connection.collection('crm_notes').insertOne({ organizationId: org('sub'), dealId: dealId.toString(), body: 'Called back, wants it by the 20th.', createdAt: new Date() });
    expect((await service.overview(admin, dealId.toString())).brief).toMatchObject({ stale: true });
  });

  it('gives the credits back when the AI fails', async () => {
    httpPost.mockReturnValueOnce(throwError(() => new Error('connect ECONNREFUSED')));
    await expect(service.analyse(caller('subAdmin', org('sub'), ['admin']), dealId.toString())).rejects.toThrow(ServiceUnavailableException);
    expect(reservations.release).toHaveBeenCalledTimes(1);
    expect(reservations.settle).not.toHaveBeenCalled();
  });

  it('runs an approved action once per key, never twice the same open task, and records each', async () => {
    const admin = caller('subAdmin', org('sub'), ['admin']);
    const first = await service.runAction(admin, dealId.toString(), { type: 'create_task', idempotencyKey: 'jest-task-key-1', title: 'Send navy sample', dueDate: '2026-11-14' });
    expect(first).toMatchObject({ type: 'create_task', status: 'done', summary: 'Task created: Send navy sample (for Deal Owner)' });
    // The same click again (same key): the first result, nothing new.
    expect(await service.runAction(admin, dealId.toString(), { type: 'create_task', idempotencyKey: 'jest-task-key-1', title: 'Send navy sample' })).toMatchObject({ status: 'done' });
    // A new click for the same open task: recognised as a duplicate.
    expect(await service.runAction(admin, dealId.toString(), { type: 'create_task', idempotencyKey: 'jest-task-key-2', title: 'Send navy sample' })).toMatchObject({ status: 'duplicate' });
    expect(await connection.collection('customer_tasks').countDocuments({ dealId: dealId.toString() })).toBe(1);

    await service.runAction(admin, dealId.toString(), { type: 'add_note', idempotencyKey: 'jest-note-key-1', text: 'Customer prefers navy; sample promised.' });
    await service.runAction(admin, dealId.toString(), { type: 'notify_owner', idempotencyKey: 'jest-notify-key-1', text: 'Ravi is waiting for a reply.' });
    expect(notifications.create).toHaveBeenCalledWith(who('owner'), expect.objectContaining({ title: 'Deal needs attention: Acme shirts', kind: 'warning' }), org('sub'));
    await service.runAction(admin, dealId.toString(), { type: 'draft_email', idempotencyKey: 'jest-draft-key-1', subject: 'Navy sample', text: 'Hi Ravi, …' });
    expect(audit.log).toHaveBeenCalledTimes(5);

    const overview = await service.overview(admin, dealId.toString());
    expect(overview.tasks.map((t) => [t.title, t.status, t.assignee, t.byAi])).toEqual([['Send navy sample', 'open', 'Deal Owner', true]]);
    expect(overview.notes.map((n) => n.body)).toContain('Customer prefers navy; sample promised.');
    expect(overview.actions.map((a) => [a.type, a.status])).toEqual(
      expect.arrayContaining([
        ['create_task', 'done'],
        ['create_task', 'duplicate'],
        ['add_note', 'done'],
        ['notify_owner', 'done'],
        ['draft_email', 'done'],
      ]),
    );
    const done = await service.setTaskDone(admin, dealId.toString(), overview.tasks[0].id, true);
    expect(done).toMatchObject({ status: 'done', overdue: false });
  });

  it('a person who may not see the deal can’t act on it', async () => {
    await expect(
      service.runAction(caller('colleague', org('sub'), ['consultant']), dealId.toString(), { type: 'add_note', idempotencyKey: 'jest-note-key-x', text: 'x' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('finds the whole email conversation: by address, thread, quotation number and the company the email AI matched', async () => {
    const galaxy = new Types.ObjectId();
    const admin = caller('subAdmin', org('sub'), ['admin']);
    const inbox = (key: string, extra: Record<string, unknown>) => ({
      organizationId: org('sub'),
      userId: who('owner'),
      mailboxEmail: 'owner@x.com',
      externalMessageId: `jest-deal-${key}-${galaxy}`,
      receivedAt: new Date('2026-11-12T03:00:00Z'),
      bodyPreview: '',
      intent: 'existing_customer',
      status: 'pending',
      ...extra,
    });
    await connection.collection('crm_deals').insertOne({ _id: galaxy, organizationId: org('sub'), name: 'Galaxy cast - Polos', dealStatus: 'open', monetaryValue: 46251, ownerId: who('owner'), stageId: '694baae22365c712b3e1afd2_stage_e3110b37-0168-499e-b306-c4d310f8de36' });
    await connection.collection('crm_quotes').insertOne({ organizationId: org('sub'), dealId: galaxy.toString(), quoteNumber: '142', quoteStatus: 'published', quoteAmount: 46251, currency: 'INR', clientDetails: { companyName: 'Galaxy Cast Tech', contactName: 'Karthik', email: 'karthik@gmail.com' }, items: [{ description: 'Tipping polo', quantity: 70, lineTotal: 43050 }], requestNotes: 'Navy with red tipping', createdAt: new Date('2026-11-11T00:00:00Z') });
    await connection.collection('email_sent_items').insertOne({ organizationId: org('sub'), userId: who('owner'), mailboxEmail: 'owner@x.com', externalMessageId: `jest-deal-g-out-${galaxy}`, sentAt: new Date('2026-11-11T05:00:00Z'), subject: 'Your quotation', toAddresses: ['karthik@gmail.com'], bodyPreview: 'Please find the quote', conversationId: `conv-${galaxy}` });
    await connection.collection('email_intelligence_items').insertMany([
      inbox('thread', { fromAddress: 'karthik.work@yahoo.com', subject: 'RE: Your quotation', conversationId: `conv-${galaxy}` }),
      inbox('subject', { fromAddress: 'buyer@elsewhere.com', subject: 'Quote #142 - sizes', conversationId: `other-${galaxy}` }),
      inbox('company', { fromAddress: 'ops@galaxycast.in', subject: 'Delivery address', matchedBusinessName: 'Galaxy Cast Tech', conversationId: `third-${galaxy}` }),
      inbox('noise', { fromAddress: 'someone@gmail.com', subject: 'Hello', conversationId: `noise-${galaxy}` }),
    ]);

    const overview = await service.overview(admin, galaxy.toString());
    expect(overview.emails.map((e) => [e.direction, e.subject]).sort()).toEqual(
      [
        ['in', 'Delivery address'],
        ['in', 'Quote #142 - sizes'],
        ['in', 'RE: Your quotation'],
        ['out', 'Your quotation'],
      ].sort(),
    );
    expect(overview.stats).toMatchObject({ emailsIn: 3, emailsOut: 1 });
    // No name is stored for a Pantheras stage: none shown, never the id.
    expect(overview.deal.stage).toBeUndefined();
    expect(overview.quotes[0]).toMatchObject({ items: [{ description: 'Tipping polo', quantity: 70, total: 43050 }], requestNotes: 'Navy with red tipping' });
  });

  it('a website enquiry (Gorilla Dash): the person who sent it, their message, and their emails', async () => {
    const lead = new Types.ObjectId();
    await connection.collection('crm_deals').insertOne({
      _id: lead,
      organizationId: org('sub'),
      name: 'Joe Doe (Bright Prints)',
      dealStatus: 'open',
      monetaryValue: 0,
      sourceProvider: 'gorilladash',
      sourceData: {
        created_at: '2026-11-10T09:00:00.000000Z',
        enquiry_form: { name: 'Inquiry Form' },
        person: { first_name: 'Joe', last_name: 'Doe', business_name: 'Bright Prints', email: 'joe@brightprints.co', number_e164: '+61400999888' },
        fields: [{ name: 'Message', value: 'Need 50 caps with our logo' }, { name: 'Business Name', value: 'Bright Prints' }, { name: 'Quantity', value: '50' }],
      },
    });
    await connection.collection('email_intelligence_items').insertOne({ organizationId: org('sub'), userId: who('owner'), mailboxEmail: 'owner@x.com', externalMessageId: `jest-deal-lead-${lead}`, receivedAt: new Date('2026-11-11T00:00:00Z'), subject: 'Caps follow up', fromAddress: 'joe@brightprints.co', bodyPreview: 'Any update?', intent: 'existing_customer', status: 'pending' });
    const overview = await service.overview(caller('subAdmin', org('sub'), ['admin']), lead.toString());
    expect(overview.customer).toMatchObject({ name: 'Joe Doe', company: 'Bright Prints', email: 'joe@brightprints.co', phone: '+61400999888' });
    expect(overview.notes.map((n) => [n.body, n.by])).toContainEqual(['Need 50 caps with our logo\nQuantity: 50', 'Inquiry Form (website)']);
    expect(overview.emails.map((e) => e.subject)).toEqual(['Caps follow up']);
  });

  it('refuses when AI access is switched off for the person', async () => {
    const off = { ...caller('subAdmin', org('sub'), ['admin']), aiAccessEnabled: false } as JwtPayload;
    await expect(service.analyse(off, dealId.toString())).rejects.toThrow(ForbiddenException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });
});

describe('deal health (worked out from the records)', () => {
  const base = {
    status: 'open' as const,
    daysSinceLastContact: 2,
    waitingForReply: 0,
    customerMessagesLast30Days: 2,
    connectedCallsLast30Days: 1,
    quoteStatuses: [{ status: 'sent', approval: 'approved' }],
    callScores: [8],
    expectedClosingDate: '2026-11-30',
    today: '2026-11-12',
    overdueFollowUps: 0,
  };

  it('weights add up to 100', () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('a well-worked deal scores full marks', () => {
    expect(dealHealth(base)).toMatchObject({ score: 100, band: 'healthy', risks: [] });
  });

  it('silence, a waiting email, no quotation and a passed closing date pull it down — each named', () => {
    const health = dealHealth({ ...base, daysSinceLastContact: 20, waitingForReply: 1, customerMessagesLast30Days: 0, connectedCallsLast30Days: 0, quoteStatuses: [], callScores: [], expectedClosingDate: '2026-11-01', overdueFollowUps: 1 });
    expect(health.score).toBe(5); // only "no scored calls" keeps half of call quality
    expect(health.band).toBe('at_risk');
    expect(health.risks).toEqual(['No contact for 20 days.', 'The customer is waiting for our reply.', 'The expected closing date has passed.', 'A follow-up is overdue.']);
    expect(health.improvements).toContain('Send a quotation.');
  });

  it('a closed deal has no health score', () => {
    expect(dealHealth({ ...base, status: 'won' })).toMatchObject({ score: null, band: 'closed' });
  });
});

describe('readable stage names', () => {
  it('shows a CRM stage written in words, never an id', () => {
    expect(readableStage('ACCEPTED_NO_JOB')).toBe('Accepted no job');
    expect(readableStage('in_production')).toBe('In production');
    expect(readableStage('694baae22365c712b3e1afd2_stage_e3110b37-0168-499e-b306-c4d310f8de36')).toBeUndefined();
    expect(readableStage('6af3f7db14b1830e8841ad41')).toBeUndefined();
    expect(readableStage(undefined)).toBeUndefined();
  });
});
