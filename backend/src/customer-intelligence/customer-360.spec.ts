import { ForbiddenException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { of } from 'rxjs';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { callStats, CallFact, classifyRelationship, DEFAULT_SETTINGS, nextBestActions, resolveSettings, scoreHealth, ThreeSixtyInput } from './customer-360';
import { Customer360Service } from './customer-360.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { validateReport } from './customer-intelligence-report';
import { CustomerMailService } from './customer-mail.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-14T10:00:00Z');
const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * DAY);

const base = (over: Partial<ThreeSixtyInput> = {}): ThreeSixtyInput => ({
  now: NOW,
  settings: DEFAULT_SETTINGS,
  firstSeenAt: daysAgo(5),
  lastActivityAt: daysAgo(2),
  orders: { count: 0, totalValue: 0 },
  peerRevenues: [],
  deals: { open: 0, won: 0, lost: 0 },
  quotes: [],
  paymentsTracked: false,
  payment: { billed: 0, paid: null, outstanding: null, overdueAmount: 0, status: 'not_recorded' },
  invoices: [],
  email: { received: 0, sent: 0, unanswered: 0, weReplyInHours: null },
  unansweredEmails: [],
  calls: [],
  followUps: [],
  inquiry: { open: false, actioned: true },
  crmLost: false,
  ...over,
});
const call = (over: Partial<CallFact> = {}): CallFact => ({
  id: `c-${Math.random()}`,
  at: daysAgo(3),
  direction: 'outbound',
  connected: true,
  missed: false,
  durationSeconds: 300,
  followUps: [],
  riskSignals: [],
  buyingSignals: [],
  ...over,
});

describe('Customer 360° rules', () => {
  it('talking to us is not buying: emails and calls without an order never make a repeat customer', () => {
    const r = classifyRelationship(
      base({ firstSeenAt: daysAgo(200), email: { received: 9, sent: 8, unanswered: 0, weReplyInHours: 3 }, calls: [call(), call(), call()] }),
    );
    expect(r.stage).toBe('existing');
    expect(r.badges[0].label).toBe('Existing contact');
    expect(r.badges[0].reasons.join(' ')).toMatch(/no completed order/);
    expect(r.purchaseHistory.completedOrders).toBe(0);
    expect(r.relationshipHistory.emails).toBe(17);
  });

  it('new, existing (one order) and repeat (from the configured number of orders)', () => {
    expect(classifyRelationship(base()).stage).toBe('new');
    expect(classifyRelationship(base({ orders: { count: 1, totalValue: 50000, lastOrderAt: daysAgo(10) } })).stage).toBe('existing');
    const repeat = classifyRelationship(base({ orders: { count: 2, totalValue: 90000, lastOrderAt: daysAgo(10) } }));
    expect(repeat.stage).toBe('repeat');
    expect(repeat.badges[0].reasons[0]).toMatch(/2 completed orders worth 90,000/);
    // Configurable: three orders needed.
    const strict = classifyRelationship(base({ settings: resolveSettings({ repeatMinOrders: 3 }), orders: { count: 2, totalValue: 90000 } }));
    expect(strict.stage).toBe('existing');
  });

  it('dormant after the configured quiet period; lost when every deal was lost', () => {
    const dormant = classifyRelationship(base({ firstSeenAt: daysAgo(400), lastActivityAt: daysAgo(120), orders: { count: 1, totalValue: 1000 } }));
    expect(dormant.active).toBe(false);
    expect(dormant.badges.find((b) => b.key === 'dormant')?.reasons[0]).toMatch(/Nothing for 120 days \(dormant after 90\)/);
    expect(classifyRelationship(base({ crmLost: true })).stage).toBe('lost');
  });

  it('at risk only on recorded facts, each given as a reason', () => {
    const r = classifyRelationship(
      base({
        email: { received: 3, sent: 1, unanswered: 2, oldestUnansweredAt: daysAgo(6), weReplyInHours: null },
        calls: [call({ direction: 'inbound', connected: false, missed: true, at: daysAgo(2) }), call({ sentiment: 'negative', at: daysAgo(1) })],
      }),
    );
    expect(r.atRisk).toBe(true);
    const reasons = r.badges.find((b) => b.key === 'at_risk')!.reasons.join(' | ');
    expect(reasons).toMatch(/waited 6 days/);
    expect(reasons).toMatch(/1 missed call/);
    expect(reasons).toMatch(/negative in tone/);
    expect(classifyRelationship(base()).atRisk).toBe(false);
  });

  it('high value by real revenue among the business’s paying customers, never by quotations', () => {
    const peers = [100, 200, 300, 400, 500, 600, 700, 800, 900, 50000];
    const top = classifyRelationship(base({ orders: { count: 1, totalValue: 50000 }, peerRevenues: peers }));
    expect(top.highValue).toBe(true);
    const quotedOnly = classifyRelationship(base({ quotes: [{ id: 'q', state: 'sent', amount: 900000, date: daysAgo(2) }], peerRevenues: peers }));
    expect(quotedOnly.highValue).toBe(false);
  });

  it('health: missing data is left out, not counted against them; too little gives no score', () => {
    const thin = scoreHealth(base());
    expect(thin.score).toBeNull();
    expect(thin.band).toBe('not_enough_data');
    const h = scoreHealth(
      base({
        orders: { count: 3, totalValue: 300000 },
        email: { received: 4, sent: 4, unanswered: 0, weReplyInHours: 2 },
        calls: [call({ sentiment: 'positive' })],
      }),
    );
    // Engagement 100, purchase 100, responsiveness 100, sentiment 100 — payment, conversion and follow-up have no data.
    expect(h.score).toBe(100);
    expect(h.parts.find((p) => p.key === 'payment')!.score).toBeNull();
    expect(h.explanation).toMatch(/Left out for lack of data: payment reliability/);
    // Weights are configurable.
    const weighted = scoreHealth(
      base({
        settings: resolveSettings({ weights: { ...DEFAULT_SETTINGS.weights, responsiveness: 100 } }),
        email: { received: 4, sent: 1, unanswered: 3, weReplyInHours: 72 },
        lastActivityAt: daysAgo(1),
      }),
    );
    expect(weighted.score).toBeLessThan(50);
  });

  it('call figures: in, out, missed, talk time, frequency and how the score moved', () => {
    const s = callStats([
      call({ at: daysAgo(60), durationSeconds: 120, score: 6.5 }),
      call({ at: daysAgo(30), direction: 'inbound', connected: false, missed: true, durationSeconds: 0 }),
      call({ at: daysAgo(1), durationSeconds: 480, score: 8 }),
    ]);
    expect(s).toMatchObject({ total: 3, incoming: 1, outgoing: 2, connected: 2, missed: 1, talkSeconds: 600, averageSeconds: 300 });
    expect(s.perMonth).toBeCloseTo(1.5, 1);
    expect(s.scoreChange).toMatch(/scored 8, up 1.5 from 6.5/);
  });

  it('next best actions name their evidence and stay stable for the same situation', () => {
    const input = base({
      unansweredEmails: [{ id: 'm1', subject: 'Price for 200 caps', at: daysAgo(2) }],
      email: { received: 1, sent: 0, unanswered: 1, oldestUnansweredAt: daysAgo(2), weReplyInHours: null },
      quotes: [{ id: 'q1', number: 'Q-77', state: 'sent', amount: 40000, date: daysAgo(8) }],
      calls: [call({ id: 'missed-1', direction: 'inbound', connected: false, missed: true, at: daysAgo(1) })],
    });
    const actions = nextBestActions(input, classifyRelationship(input));
    expect(actions.map((a) => a.key)).toEqual(expect.arrayContaining(['reply:m1', 'quote:q1', 'callback:missed-1']));
    expect(actions.find((a) => a.key === 'quote:q1')).toMatchObject({ priority: 'high', evidence: [{ kind: 'quotation', id: 'q1', label: 'Quotation Q-77' }] });
    expect(nextBestActions(input, classifyRelationship(input)).map((a) => a.key)).toEqual(actions.map((a) => a.key));
    // No payment reminder when payments aren't recorded.
    expect(actions.some((a) => a.key.startsWith('payment:'))).toBe(false);
  });

  it('settings are kept in range', () => {
    expect(resolveSettings({ dormantAfterDays: 2, weights: { engagement: 500 } as never })).toMatchObject({ dormantAfterDays: 7, weights: { engagement: 100, purchase: 20 } });
  });
});

describe('AI report guard', () => {
  const evidence = [
    { id: 'E1', kind: 'call' as const, label: 'Call of 10 Nov' },
    { id: 'E2', kind: 'quotation' as const, refId: 'q1', label: 'Quotation Q-1' },
  ];
  it('keeps only statements citing evidence it was given; no evidence means "Not enough data"', () => {
    const report = validateReport(
      {
        summary: 'Asked for a lower price than their current supplier.',
        buyingIntent: { level: 'high', reason: 'Asked for a revised quote.', evidence: ['E2'] },
        sentiment: { overall: 'positive', trend: 'stable', reason: 'Warm call.', evidence: ['E9'] },
        behaviours: [
          { trait: 'price_sensitive', explanation: 'Compared prices on the call.', evidence: ['E1'] },
          { trait: 'quality_focused', explanation: 'Invented.', evidence: [] },
          { trait: 'made_up_trait', explanation: 'Not a known trait.', evidence: ['E1'] },
        ],
        competitors: [
          { name: 'Current supplier (unnamed)', context: 'Cheaper by 5%', risk: 'May stay with them', response: 'Match on volume', evidence: ['e1'] },
          { name: 'Rival Co', context: 'Never mentioned', risk: '', response: '', evidence: ['E7'] },
        ],
        insights: [{ text: 'Quote Q-1 is still open.', basis: 'fact', evidence: ['E2'] }],
        recommendations: [{ action: 'Send a competitive quote', reason: 'Price objection', priority: 'high', deadline: 'today', outcome: 'Order', evidence: ['E1', 'E2'] }],
      },
      evidence,
    );
    expect(report.buyingIntent).toMatchObject({ level: 'high', evidence: ['E2'] });
    // Cited a record that was never given: dropped to "unknown / Not enough data".
    expect(report.sentiment.overall).toBe('unknown');
    expect(report.sentiment.reason).toMatch(/Not enough data/);
    expect(report.behaviours.map((b) => b.trait)).toEqual(['price_sensitive']);
    expect(report.competitors.map((c) => c.name)).toEqual(['Current supplier (unnamed)']);
    expect(report.competitors[0].evidence).toEqual(['E1']);
    expect(report.recommendations[0].evidence).toEqual(['E1', 'E2']);
    expect(report.dropped).toBe(4);
  });

  it('a malformed answer becomes an empty, honest report', () => {
    const report = validateReport('not json', evidence);
    expect(report).toMatchObject({ summary: '', behaviours: [], competitors: [], buyingIntent: { level: 'unknown' }, sentiment: { overall: 'unknown' } });
  });
});

// Against a real Mongo: search finds a customer by phone, email, quotation or
// name; their calls are found by phone; one business never sees another's
// customers or calls; the Main Account owner sees a sub-account's; a follow-up
// is created once however often it is asked for.
describe('Customer 360° (real Mongo)', () => {
  let connection: Connection;
  let service: Customer360Service;
  const PREFIX = `jest-c360-${Date.now()}`;
  const main = new Types.ObjectId();
  const sub = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const ownerId = new Types.ObjectId().toString();
  const workspace = { addTask: jest.fn(async () => ({ id: 'task-1', title: 'x', status: 'open' })) };
  const audit = { log: jest.fn(async () => undefined) };
  const http = { post: jest.fn() };
  const reservations = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (org: string) => org };
  const ownerOf = (org: Types.ObjectId) => ({ sub: ownerId, email: 'owner@example.com', organizationId: org.toString(), roles: ['owner'] }) as never;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    await connection.collection('organizations').insertMany([
      { _id: main, name: `${PREFIX} Main`, slug: `${PREFIX}-main`, prefix: PREFIX },
      { _id: sub, name: `${PREFIX} Sub`, slug: `${PREFIX}-sub`, parentOrganizationId: main.toString(), prefix: PREFIX },
      { _id: stranger, name: `${PREFIX} Stranger`, slug: `${PREFIX}-stranger`, prefix: PREFIX },
    ]);
    const seedCustomer = async (org: Types.ObjectId, email: string, phone: string, name: string) => {
      const orgId = org.toString();
      const source = (await connection.collection('crm_data_sources').insertOne({ organizationId: orgId, key: 'prospectconnect', provider: 'prospectconnect', label: 'Pantheras CRM', status: 'active' })).insertedId.toString();
      const client = { contactName: name, companyName: 'Acme Uniforms', email, phone };
      const quote = (n: string, amount: number, at: Date, approval: string) => ({
        organizationId: orgId,
        dataSourceId: source,
        quoteNumber: n,
        quoteName: `Polo shirts ${n}`,
        quoteAmount: amount,
        quoteStatus: 'published',
        clientApprovalStatus: approval,
        clientDetails: client,
        createdAt: at,
      });
      await connection.collection('crm_quotes').insertMany([quote(`${PREFIX}-Q1`, 50000, daysAgo(200, new Date()), 'approved'), quote(`${PREFIX}-Q2`, 70000, daysAgo(40, new Date()), 'approved'), quote(`${PREFIX}-Q3`, 30000, daysAgo(6, new Date()), 'awaiting_response')]);
      const session = (await connection.collection('call_sessions').insertOne({ organizationId: orgId, userId: ownerId, status: 'ended', source: 'live', creditRequestId: `${PREFIX}-${orgId}`, createdAt: daysAgo(3, new Date()), headline: 'Wants 300 polos, price higher than current supplier', sentiment: 'positive', overallScore: 7.5, summaryPoints: ['Asked for 300 polos'], keyMoments: [{ momentType: 'buying_signal', text: 'Ready to order this month' }], followUpActions: [{ text: 'Send revised quote', priority: 'high', owner: 'salesperson' }] })).insertedId.toString();
      await connection.collection('plivo_calls').insertMany([
        { organizationId: orgId, userId: ownerId, direction: 'outbound', customerNumber: `+91${phone.replace(/\D/g, '').slice(-10)}`, status: 'completed', durationSeconds: 420, answeredAt: daysAgo(3, new Date()), sessionId: session, createdAt: daysAgo(3, new Date()) },
        { organizationId: orgId, userId: ownerId, direction: 'inbound', customerNumber: `0${phone.replace(/\D/g, '').slice(-10)}`, status: 'no-answer', createdAt: daysAgo(1, new Date()) },
      ]);
    };
    await seedCustomer(sub, 'ravi@acme-uniforms-test.in', '+91 98400 12345', 'Ravi Kumar');
    // Another business with the very same customer details: must never be seen from the Main Account's tree.
    await seedCustomer(stranger, 'ravi@acme-uniforms-test.in', '+91 98400 12345', 'Ravi Kumar');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const directory = new CustomerDirectoryService(
      connection,
      new CustomerMailService(connection),
      { syncNow: jest.fn() } as never,
      reservations as never,
      http as never,
      { sign: () => 'jwt' } as never,
      { findAll: async () => [] } as never,
      { get: () => 'http://agent' } as never,
    );
    service = new Customer360Service(
      connection,
      directory,
      new TeamScopeService(connection),
      workspace as never,
      reservations as never,
      audit as never,
      http as never,
      { sign: () => 'jwt' } as never,
      { get: () => 'http://agent' } as never,
    );
  });

  afterAll(async () => {
    const orgIds = [main, sub, stranger].map((o) => o.toString());
    for (const name of ['crm_data_sources', 'crm_quotes', 'call_sessions', 'plivo_calls', 'customer_intelligence_actions', 'customer_health_snapshots', 'customer_intelligence_reports', 'customer_intelligence_settings']) {
      await connection.collection(name).deleteMany({ organizationId: { $in: orgIds } });
    }
    await connection.collection('organizations').deleteMany({ prefix: PREFIX });
    await connection.close();
  });

  it('finds the customer by phone (any format), email, quotation number and name — in the sub-account, never the stranger', async () => {
    for (const q of ['9840012345', '+91 98400 12345', 'ravi@acme-uniforms-test.in', `${PREFIX}-Q2`, 'ravi kumar']) {
      const { results } = await service.search(ownerOf(main), q);
      expect({ q, businesses: results.map((r) => r.business.id) }).toEqual({ q, businesses: [sub.toString()] });
    }
    const byPhone = await service.search(ownerOf(main), '98400 12345');
    expect(byPhone.results[0].matchedOn).toContain('phone');
  });

  it('the Dialer’s contact search finds a number typed without spaces (its digit filter had lost a backslash)', async () => {
    const directory = (service as unknown as { directory: CustomerDirectoryService }).directory;
    const found = await directory.searchCallable(sub.toString(), '9840012345');
    expect(found.map((c) => c.name)).toEqual(['Ravi Kumar']);
    expect(found[0].phones[0].number).toBe('+91 98400 12345');
  });

  it('builds the profile: repeat customer by completed orders, calls matched by phone with their report', async () => {
    const { results } = await service.search(ownerOf(main), 'ravi@acme-uniforms-test.in');
    const p = await service.profile(ownerOf(main), sub.toString(), results[0].id);
    expect(p.relationship.stage).toBe('repeat');
    expect(p.revenue).toMatchObject({ completedOrders: 2, lifetimeRevenue: 120000 });
    expect(p.calls.stats).toMatchObject({ total: 2, outgoing: 1, incoming: 1, missed: 1, connected: 1 });
    const recorded = p.calls.list.find((c) => c.connected)!;
    expect(recorded).toMatchObject({ headline: expect.stringMatching(/300 polos/), score: 7.5, buyingSignals: ['Ready to order this month'] });
    expect(p.actions.map((a) => a.key)).toEqual(expect.arrayContaining([expect.stringMatching(/^callback:/)]));
    expect(p.timeline.some((e) => e.kind === 'call_missed')).toBe(true);
    // Opening a customer's calls is recorded.
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer_360_view', organizationId: sub.toString() }));
  });

  it('keeps businesses apart: a sub-account owner can’t open the Main Account’s tree or a stranger', async () => {
    await expect(service.search(ownerOf(sub), 'ravi', main.toString())).rejects.toThrow(ForbiddenException);
    const own = await service.search(ownerOf(sub), 'ravi');
    expect(own.results.every((r) => r.business.id === sub.toString())).toBe(true);
    const { results } = await service.search(ownerOf(stranger), 'ravi');
    await expect(service.profile(ownerOf(stranger), sub.toString(), results[0].id)).rejects.toThrow(ForbiddenException);
  });

  it('a follow-up is created once, however often it is asked for; a dismissed action leaves the list', async () => {
    const { results } = await service.search(ownerOf(main), 'ravi@acme-uniforms-test.in');
    const id = results[0].id;
    const first = await service.decide(ownerOf(main), sub.toString(), id, { key: 'quote:abc', decision: 'follow_up', title: 'Chase Q3' });
    const again = await service.decide(ownerOf(main), sub.toString(), id, { key: 'quote:abc', decision: 'follow_up', title: 'Chase Q3' });
    expect(first).toMatchObject({ status: 'follow_up', taskId: 'task-1' });
    expect(again).toMatchObject({ status: 'follow_up', taskId: 'task-1' });
    expect(workspace.addTask).toHaveBeenCalledTimes(1);
    // The task is made in the customer's business.
    expect(workspace.addTask).toHaveBeenCalledWith(expect.objectContaining({ organizationId: sub.toString() }), id, expect.objectContaining({ title: 'Chase Q3' }));

    const p = await service.profile(ownerOf(main), sub.toString(), id);
    const callback = p.actions.find((a) => a.key.startsWith('callback:'))!;
    await service.decide(ownerOf(main), sub.toString(), id, { key: callback.key, decision: 'dismissed' });
    const after = await service.profile(ownerOf(main), sub.toString(), id);
    expect(after.actions.some((a) => a.key === callback.key)).toBe(false);
    expect(after.dismissedActions).toBe(1);
  });

  it('Call Copilot’s snapshot: the customer on a call in a few lines, found by the number dialled', async () => {
    const snap = await service.snapshot(ownerOf(sub), { phone: '+91 98400 12345' });
    expect(snap).toMatchObject({
      found: true,
      customer: { name: 'Ravi Kumar' },
      stage: { label: 'Repeat customer' },
      orders: 2,
      revenue: 120000,
      openQuotes: 1,
      lastCall: { summary: expect.stringMatching(/300 polos/) },
    });
    if (!snap.found || snap.restricted) throw new Error('expected a full snapshot');
    expect(snap.nextSteps.length).toBeGreaterThan(0);
    expect(snap.nextSteps.length).toBeLessThanOrEqual(2);
    // A number nobody has: nothing to show.
    expect(await service.snapshot(ownerOf(sub), { phone: '+91 90000 00001' })).toEqual({ found: false });
    // A salesperson who isn't this customer's rep sees that a customer exists, nothing more (the Dialer's rule).
    const salesperson = { sub: new Types.ObjectId().toString(), email: 's@example.com', organizationId: sub.toString(), roles: ['user'] } as never;
    expect(await service.snapshot(salesperson, { phone: '9840012345' })).toEqual({ found: true, restricted: true });
  });

  it('the AI report: billed, checked against its evidence, and not re-run while nothing changed', async () => {
    const { results } = await service.search(ownerOf(main), 'ravi@acme-uniforms-test.in');
    const id = results[0].id;
    http.post.mockReturnValue(
      of({
        data: {
          summary: 'Repeat buyer weighing a new order.',
          buyingIntent: { level: 'high', reason: 'Said ready to order.', evidence: ['E1', 'E99'] },
          sentiment: { overall: 'positive', trend: 'stable', reason: 'Warm call.', evidence: [] },
          behaviours: [],
          preferences: [],
          painPoints: [],
          competitors: [{ name: 'Made Up Ltd', context: '', risk: '', response: '', evidence: [] }],
          insights: [],
          recommendations: [],
        },
      }),
    );
    const report = await service.analyze(ownerOf(main), sub.toString(), id, false);
    expect(reservations.reserve).toHaveBeenCalledWith(sub.toString(), ownerId, expect.any(String), 'customer-intelligence');
    expect(reservations.settle).toHaveBeenCalled();
    expect(report.buyingIntent.evidence).toEqual(['E1']);
    expect(report.sentiment.overall).toBe('unknown');
    expect(report.competitors).toEqual([]);
    // What the AI was shown carries no contact details.
    const sent = JSON.stringify(http.post.mock.calls[0][1]);
    expect(sent).not.toMatch(/acme-uniforms-test\.in|98400/);
    // Asked again with nothing new: the saved report, no second charge.
    await service.analyze(ownerOf(main), sub.toString(), id, false);
    expect(reservations.reserve).toHaveBeenCalledTimes(1);
  });
});
