import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Types } from 'mongoose';
import { from, of, throwError } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AssistantService, factsHash, shouldSpeakFor } from './assistant.service';
import { BriefingFacts, BriefingFactsService, DEFAULT_QUESTIONS } from './briefing-facts.service';
import { defaultSettings } from './conversation-settings';
import { ConversationSettingsService } from './conversation-settings.service';

// Haive's spoken briefing: written by the AI from the business's own facts, once
// per person per day, reused while the facts are the same, billed like every AI
// action, opened as a real chat conversation, and spoken on its own only the
// first time that day. Against a real Mongo for the stored briefing; the AI,
// billing and chat are stand-ins.

const BRIEFING = {
  spoken: 'Good morning, Vasanth. Nine emails are waiting…',
  headline: 'Nine emails waiting; revenue on track.',
  points: [{ text: '9 emails waiting', kind: 'actual', severity: 'warning', business: 'T.Nagar' }],
  nextAction: { text: 'Answer the 3 new enquiries', why: 'They are 2 days old' },
  suggestedQuestions: ['Which deals close this week?'],
};

function facts(overrides: Partial<BriefingFacts> = {}): BriefingFacts {
  return {
    person: { firstName: 'Vasanth', sees: 'all_businesses' },
    now: { date: '2026-11-23', weekday: 'Monday', timeOfDay: 'morning', timeZone: 'Asia/Kolkata' },
    language: 'en',
    businesses: [],
    attention: ['T.Nagar: 9 emails waiting for a reply.'],
    teamNeedsSupport: [],
    actionPeople: [],
    me: { tasks: { open: 0, inProgress: 0, overdue: 0, dueToday: 0 } },
    questions: DEFAULT_QUESTIONS,
    notTracked: ['payments'],
    ...overrides,
  };
}

describe('Haive’s spoken briefing (real Mongo for what is stored)', () => {
  let connection: Connection;
  let service: AssistantService;
  let current: BriefingFacts;
  let settings: ConversationSettingsService;
  const build = jest.fn(async (..._args: unknown[]) => current);
  // Reach-outs sent (slot → why Haive reached out); none unless a test adds one.
  const reachOuts = new Map<string, { label: string; focus: string }>();
  const proactive = { eventForSlot: jest.fn(async (_c: unknown, slot: string) => reachOuts.get(slot) ?? null) };
  const http = { post: jest.fn() };
  const reservations = { resolveTenantKey: jest.fn(() => 'tenant'), reserve: jest.fn(async () => ({})), settle: jest.fn(async () => undefined), release: jest.fn(async () => undefined) };
  const chat = { createSystemConversationRecord: jest.fn(async () => ({ conversationId: 'conv-1' })) };
  const giveTask = jest.fn(async (_c: unknown, input: { assigneeId: string }) => ({ id: 'task-1', personName: input.assigneeId === 'abi-id' ? 'Abishake' : 'Vasanth G' }));
  const org = new Types.ObjectId().toString();
  const caller = (extra: Partial<JwtPayload> = {}) => ({ sub: 'jest-assistant-user', organizationId: org, roles: ['owner'], email: 'v@example.com', ...extra }) as JwtPayload;
  const now = new Date('2026-11-23T04:00:00Z');

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri)] }).compile();
    connection = moduleRef.get(getConnectionToken());
    settings = new ConversationSettingsService(connection);
    service = new AssistantService(
      connection,
      { build } as unknown as BriefingFactsService,
      settings,
      proactive as never,
      reservations as never,
      chat as never,
      { giveTask } as never,
      http as never,
      { sign: () => 'token' } as never,
      { get: () => 'http://python' } as never,
    );
  });

  beforeEach(async () => {
    current = facts();
    reachOuts.clear();
    jest.clearAllMocks();
    http.post.mockReturnValue(of({ data: BRIEFING }));
    await connection.collection('ai_briefings').deleteMany({ organizationId: org });
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: org });
  });

  afterAll(async () => {
    await connection.collection('ai_briefings').deleteMany({ organizationId: org });
    await connection.collection('ai_conversation_settings').deleteMany({ organizationId: org });
    await connection.close();
  });

  it('writes the briefing from the facts, bills it, and opens it as a chat conversation', async () => {
    const view = await service.briefing(caller(), {}, now);
    expect(view).toMatchObject({ date: '2026-11-23', slot: 'login', conversationId: 'conv-1', shouldSpeak: true, briefing: BRIEFING });
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('http://python/assistant/briefing');
    expect(body.facts.attention).toEqual(['T.Nagar: 9 emails waiting for a reply.']);
    expect(reservations.reserve).toHaveBeenCalledWith('tenant', 'jest-assistant-user', body.request_id, 'assistant-briefing');
    expect(reservations.settle).toHaveBeenCalledWith(body.request_id);
    expect(chat.createSystemConversationRecord).toHaveBeenCalledWith('jest-assistant-user', org, undefined, 'Haive briefing · Monday 2026-11-23', 'Brief me on my business.', BRIEFING.spoken);
  });

  it('the same facts reuse it — a reload costs nothing; new facts after a while write a fresh one', async () => {
    await service.briefing(caller(), {}, now);
    await service.briefing(caller(), {}, new Date(now.getTime() + 60 * 60_000));
    expect(http.post).toHaveBeenCalledTimes(1);
    // Something changed, but only minutes ago: still the same briefing.
    current = facts({ attention: ['T.Nagar: 10 emails waiting for a reply.'] });
    await service.briefing(caller(), {}, new Date(now.getTime() + 5 * 60_000));
    expect(http.post).toHaveBeenCalledTimes(1);
    // Later on, with new facts: a fresh one.
    await service.briefing(caller(), {}, new Date(now.getTime() + 2 * 60 * 60_000));
    expect(http.post).toHaveBeenCalledTimes(2);
    // Asked for: always fresh.
    await service.briefing(caller(), { refresh: true }, new Date(now.getTime() + 2 * 60 * 60_000 + 1000));
    expect(http.post).toHaveBeenCalledTimes(3);
  });

  it('two tabs opening at once write one briefing', async () => {
    const [a, b] = await Promise.all([service.briefing(caller(), {}, now), service.briefing(caller(), {}, now)]);
    expect(a.id).toBe(b.id);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('spoken on its own only the first time today — even after it is rewritten', async () => {
    const first = await service.briefing(caller(), {}, now);
    await service.markSpoken(caller(), first.id, now);
    expect((await service.briefing(caller(), {}, now)).shouldSpeak).toBe(false);
    expect((await service.briefing(caller(), { refresh: true }, now)).shouldSpeak).toBe(false);
    // Someone else can't mark it.
    await expect(service.markSpoken(caller({ sub: 'someone-else' }), first.id, now)).rejects.toThrow();
  });

  it('when the AI fails, the credits are released and the person is told in words', async () => {
    http.post.mockReturnValueOnce(throwError(() => new Error('python down')));
    await expect(service.briefing(caller(), {}, now)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(reservations.release).toHaveBeenCalled();
    expect(reservations.settle).not.toHaveBeenCalled();
    expect(await connection.collection('ai_briefings').countDocuments({ organizationId: org })).toBe(0);
  });

  it('someone whose AI access is switched off gets none', async () => {
    await expect(service.briefing(caller({ aiAccessEnabled: false }), {}, now)).rejects.toBeInstanceOf(ForbiddenException);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('the fingerprint ignores the time of day, not the facts', () => {
    const a = facts();
    expect(factsHash(a)).toBe(factsHash({ ...a, now: { ...a.now, timeOfDay: 'evening' } }));
    expect(factsHash(a)).not.toBe(factsHash({ ...a, attention: [] }));
    expect(factsHash(a, 'concise')).not.toBe(factsHash(a, 'detailed'));
  });

  it('written the way the person set it: their language, questions, what they follow, how much to say', async () => {
    await settings.updateMine(caller(), {
      language: 'ta',
      style: 'detailed',
      questions: [
        { text: 'Which quotes are waiting?', enabled: true },
        { text: 'How is each salesperson performing?', enabled: false },
      ],
      metrics: { calls: false },
    });
    await service.briefing(caller(), {}, now);
    const options = build.mock.calls[0][1] as { language: string; questions: string[]; metrics: Record<string, boolean> };
    expect(options.language).toBe('ta');
    expect(options.questions).toEqual(['Which quotes are waiting?']);
    expect(options.metrics).toMatchObject({ calls: false, revenue: true });
    expect(http.post.mock.calls[0][1].style).toBe('detailed');
  });

  it('changing those settings writes it again at once — no waiting out the reuse window', async () => {
    await service.briefing(caller(), {}, now);
    await settings.updateMine(caller(), { language: 'hi' });
    current = facts({ language: 'hi' });
    await service.briefing(caller(), {}, new Date(now.getTime() + 60_000));
    expect(http.post).toHaveBeenCalledTimes(2);
    // Changing something it isn't written from (quiet hours) doesn't.
    await settings.updateMine(caller(), { quietHours: { enabled: false, start: '20:00', end: '08:00' } });
    await service.briefing(caller(), {}, new Date(now.getTime() + 2 * 60_000));
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('a briefing still being written in the old language isn’t handed to a request made after the change', async () => {
    let finishFirst: () => void = () => undefined;
    http.post.mockImplementationOnce(() => from(new Promise<{ data: typeof BRIEFING }>((resolve) => (finishFirst = () => resolve({ data: { ...BRIEFING, spoken: 'வணக்கம்' } })))));
    await settings.updateMine(caller(), { language: 'ta' });
    const first = service.briefing(caller(), {}, now);
    // Let the first one reach the AI before the language changes.
    await new Promise((r) => setTimeout(r, 50));
    await settings.updateMine(caller(), { language: 'en' });
    const second = await service.briefing(caller(), {}, now);
    finishFirst();
    await first;
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(second.briefing.spoken).toBe(BRIEFING.spoken);
    expect(http.post.mock.calls[1][1].facts).toEqual({ ...current, actionTargets: undefined });
    expect((build.mock.calls[1][1] as { language: string }).language).toBe('en');
  });

  it('opened from a reach-out: written for that slot, leading with why Haive reached out, under its name', async () => {
    reachOuts.set('a-enquiries-b1', { label: 'Alert · T.Nagar', focus: '3 new customer enquiries at T.Nagar have had no reply for over 2 hours.' });
    const view = await service.briefing(caller(), { slot: 'a-enquiries-b1' }, now);
    expect(view).toMatchObject({ slot: 'a-enquiries-b1', label: 'Alert · T.Nagar', shouldSpeak: true });
    expect(http.post.mock.calls[0][1].facts.focus).toBe('3 new customer enquiries at T.Nagar have had no reply for over 2 hours.');
    expect(chat.createSystemConversationRecord).toHaveBeenCalledWith('jest-assistant-user', org, undefined, 'Alert · T.Nagar · Monday 2026-11-23', 'Brief me on my business.', BRIEFING.spoken);
    // The sign-in briefing is a different one.
    expect((await service.briefing(caller(), {}, now)).slot).toBe('login');
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('a slot nothing was sent for is just today’s briefing — made-up slots don’t each cost one', async () => {
    const a = await service.briefing(caller(), { slot: 's-made-up' }, now);
    const b = await service.briefing(caller(), { slot: 's-another' }, now);
    expect([a.slot, b.slot, a.label]).toEqual(['login', 'login', null]);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  describe('what Haive offers to do — only on the person’s yes', () => {
    const targets = {
      p1: { personId: 'abi-id', businessId: 'b-tnagar', name: 'Abishake', timeZone: 'Asia/Kolkata' },
      me: { personId: 'jest-assistant-user', businessId: org, name: 'you', timeZone: 'Asia/Kolkata' },
    };
    const suggesting = (actions: unknown[]) => {
      current = facts({ actionPeople: [{ ref: 'p1', name: 'Abishake' }, { ref: 'me', name: 'yourself' }], actionTargets: targets });
      http.post.mockReturnValue(of({ data: { ...BRIEFING, actions } }));
    };

    it('kept only for people this person may give tasks to; who they are never goes to the AI', async () => {
      suggesting([
        { type: 'give_task', personRef: 'p1', title: 'Reply to the 6 waiting enquiries', due: 'today' },
        { type: 'give_task', personRef: 'p9', title: 'Someone the facts never named', due: 'today' },
        { type: 'send_email', personRef: 'p1', title: 'Not a kind Haive can do' },
        { type: 'give_task', personRef: 'me', title: 'Call back Ramesh about the polos', due: 'tomorrow' },
      ]);
      const view = await service.briefing(caller(), {}, now);
      expect(view.briefing.actions).toEqual([
        { id: 'a1', type: 'give_task', label: 'Give Abishake a task: Reply to the 6 waiting enquiries', title: 'Reply to the 6 waiting enquiries', personName: 'Abishake', due: 'today', status: 'suggested' },
        { id: 'a2', type: 'give_task', label: 'Add to your tasks: Call back Ramesh about the polos', title: 'Call back Ramesh about the polos', personName: 'you', due: 'tomorrow', status: 'suggested' },
      ]);
      expect(JSON.stringify(http.post.mock.calls[0][1])).not.toContain('abi-id');
      expect(JSON.stringify(view)).not.toContain('abi-id');
    });

    it('“Do it”: the task is given from what was stored — once, however many taps — and only then “done”', async () => {
      suggesting([{ type: 'give_task', personRef: 'p1', title: 'Reply to the 6 waiting enquiries', due: 'today' }]);
      const view = await service.briefing(caller(), {}, now);
      const done = await service.runAction(caller(), view.id, 'a1', now);
      expect(done).toMatchObject({ status: 'done', result: 'Task given to Abishake — due today.' });
      expect(giveTask).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'jest-assistant-user' }),
        { organizationId: 'b-tnagar', assigneeId: 'abi-id', title: 'Reply to the 6 waiting enquiries', dueDate: '2026-11-23T18:29:00.000Z', note: 'Suggested by Haive in your briefing.' },
        now,
      );
      // A second tap: the same answer, no second task.
      await expect(service.runAction(caller(), view.id, 'a1', now)).resolves.toMatchObject({ status: 'done' });
      expect(giveTask).toHaveBeenCalledTimes(1);
      expect((await service.briefing(caller(), {}, now)).briefing.actions[0].status).toBe('done');
    });

    it('when it fails, it isn’t “done”: the reason is kept and it can be tried again', async () => {
      suggesting([{ type: 'give_task', personRef: 'p1', title: 'Reply to the 6 waiting enquiries', due: 'today' }]);
      const view = await service.briefing(caller(), {}, now);
      giveTask.mockRejectedValueOnce(new ForbiddenException('You can’t give tasks to that person.'));
      await expect(service.runAction(caller(), view.id, 'a1', now)).rejects.toBeInstanceOf(ForbiddenException);
      const after = (await service.briefing(caller(), {}, now)).briefing.actions[0];
      expect(after).toMatchObject({ status: 'suggested', error: 'You can’t give tasks to that person.' });
      await expect(service.runAction(caller(), view.id, 'a1', now)).resolves.toMatchObject({ status: 'done' });
    });

    it('“Not now”, and nobody else can act on someone’s briefing', async () => {
      suggesting([{ type: 'give_task', personRef: 'p1', title: 'Reply to the 6 waiting enquiries', due: 'today' }]);
      const view = await service.briefing(caller(), {}, now);
      await expect(service.dismissAction(caller(), view.id, 'a1')).resolves.toMatchObject({ status: 'dismissed' });
      await expect(service.runAction(caller({ sub: 'someone-else' }), view.id, 'a1', now)).rejects.toThrow('Briefing not found.');
      expect(giveTask).not.toHaveBeenCalled();
    });
  });

  it('greeting “only when I tap” and voice off: it never speaks on its own', async () => {
    await settings.updateMine(caller(), { greeting: 'tap' });
    expect((await service.briefing(caller(), {}, now)).shouldSpeak).toBe(false);
    await settings.updateMine(caller(), { greeting: 'first_of_day', voiceEnabled: false });
    expect((await service.briefing(caller(), {}, now)).shouldSpeak).toBe(false);
  });

  it('greeting “every sign-in”: heard in one session, it greets again in the next one', async () => {
    await settings.updateMine(caller(), { greeting: 'every_login' });
    const first = await service.briefing(caller({ jti: 'session-a' }), {}, now);
    expect(first.shouldSpeak).toBe(true);
    await service.markSpoken(caller({ jti: 'session-a' }), first.id, now);
    expect((await service.briefing(caller({ jti: 'session-a' }), {}, now)).shouldSpeak).toBe(false);
    expect((await service.briefing(caller({ jti: 'session-b' }), {}, now)).shouldSpeak).toBe(true);
  });

  it('shouldSpeakFor: the three greeting rules', () => {
    const s = defaultSettings();
    expect(shouldSpeakFor({}, s)).toBe(true);
    expect(shouldSpeakFor({ spokenAt: now }, s)).toBe(false);
    expect(shouldSpeakFor({ spokenAt: now, spokenSessions: ['a'] }, { ...s, greeting: 'every_login' }, 'b')).toBe(true);
    // A token with no session (an API token) falls back to once a day.
    expect(shouldSpeakFor({ spokenAt: now }, { ...s, greeting: 'every_login' })).toBe(false);
    expect(shouldSpeakFor({}, { ...s, greeting: 'tap' })).toBe(false);
  });
});

// The facts: each person told only what they may see.
describe('BriefingFactsService', () => {
  const business = {
    id: 'b1',
    name: 'Fully Promoted T.Nagar',
    currency: 'INR',
    revenue: { achieved: 226851.17, target: 400000, pct: 56.7, periodGonePct: 50 },
    deals: { won: { count: 5, value: 226851.17 }, lost: { count: 1, value: 11210 }, open: { count: 6, value: 799746 }, winRatePct: 83 },
    pipeline: { open: { count: 17, value: 1481505.5 }, pastDue: { count: 10, value: 714411.15 } },
    emails: { waiting: 3, overdue: 3, newEnquiries: 2 },
    health: [{ kind: 'mailbox', label: 'enquiry@x.in', status: 'failing' }],
  };
  const empty = { ...business, id: 'main', name: 'Main', revenue: { achieved: 0, target: null, pct: null, periodGonePct: 50 }, pipeline: { open: { count: 0, value: 0 }, pastDue: { count: 0, value: 0 } }, emails: { waiting: 0, overdue: 0, newEnquiries: 0 }, health: [] };

  function build(team: boolean, opts: { storeId?: string; across?: boolean } = {}) {
    const scopes = {
      resolve: async () => ({ team, storeId: opts.storeId, acrossBusinesses: !!opts.across, selfId: 'u1', businesses: [{ id: 'b1', name: 'T.Nagar', timeZone: 'Asia/Kolkata', isCurrent: true, isMain: false, currency: 'INR' }] }),
    };
    const businesses = {
      forBriefing: async () =>
        team && !opts.storeId
          ? {
              businesses: [business, empty],
              attention: [
                { businessName: 'T.Nagar', topic: 'sync', text: 'Mailbox enquiry@x.in isn’t being read since 20 Nov.' },
                { businessName: 'T.Nagar', topic: 'emails', text: '3 emails waiting for a reply, all over 24 hours.' },
                { businessName: 'T.Nagar', topic: 'subscription', text: 'No active subscription — its team can only open Billing.' },
              ],
            }
          : null,
      briefingExtras: async () => new Map(team && !opts.storeId ? [['b1', { quotesAwaitingDecision: { count: 4, value: 52000.4 }, closingThisWeek: [{ name: 'Polos', value: 133138.95, closes: '2026-11-27' }] }]] : []),
    };
    const activity = {
      overview: async (_c: unknown, q: { period: string }) =>
        q.period === 'last7'
          ? { attention: [{ personId: 'abi-id', personName: 'Abishake', businessId: 'b1', businessName: 'T.Nagar', text: '2 tasks past the day they were due.' }] }
          : { businesses: [{ id: 'b1', totals: { calls: 4, callsMissed: 1 } }], people: [{ calls: 2, callsMissed: 1 }] },
      myTasks: jest.fn(async () => ({ items: [{ status: 'pending', dueDate: new Date('2026-11-23T10:00:00Z') }], open: 1, inProgress: 0, overdue: 0 })),
    };
    const emails = { businessInboxCounts: jest.fn(async () => ({ waiting: 5, overdue: 2, newEnquiries: 1 })) };
    const connection = { collection: () => ({ findOne: async () => ({ name: 'Vasanth G' }) }) };
    return { service: new BriefingFactsService(connection as never, scopes as never, businesses as never, activity as never, emails as never), emails, activity };
  }
  const who = { sub: '6ae851d54d2ad5198da3d540', organizationId: 'b1', roles: ['owner'], email: 'v@x.in' } as JwtPayload;
  const at = new Date('2026-11-23T04:00:00Z'); // 09:30 in India

  it('an owner: the business’s own figures, rounded; empty businesses left out; a forecast marked as one', async () => {
    const f = await build(true).service.build(who, {}, at);
    expect(f.person).toEqual({ firstName: 'Vasanth', sees: 'business' });
    expect(f.now).toMatchObject({ date: '2026-11-23', timeOfDay: 'morning' });
    expect(f.businesses.map((b) => b.name)).toEqual(['Fully Promoted T.Nagar']);
    expect(f.businesses[0]).toMatchObject({
      revenueThisMonth: { actual: 226851, target: 400000, percentOfTarget: 56.7, monthGonePercent: 50, projectedMonthEnd: 453702 },
      openPipeline: { deals: 17, value: 1481506, pastClosingDate: 10 },
      quotesAwaitingDecision: { count: 4, value: 52000 },
      inbox: { waitingForReply: 3, waitingOver24h: 3, newEnquiries: 2 },
      callsToday: { total: 4, missed: 1 },
      problems: ['Mailbox enquiry@x.in: not syncing'],
    });
    expect(f.teamNeedsSupport).toEqual([{ person: 'Abishake', ref: 'p1', reason: '2 tasks past the day they were due.' }]);
    // Haive may suggest a task for them or for the owner — by ref; who that is stays on the server.
    expect(f.actionPeople).toEqual([{ ref: 'p1', name: 'Abishake' }, { ref: 'me', name: 'yourself' }]);
    expect(f.actionTargets).toEqual({
      p1: { personId: 'abi-id', businessId: 'b1', name: 'Abishake', timeZone: 'Asia/Kolkata' },
      me: { personId: who.sub, businessId: 'b1', name: 'you', timeZone: 'Asia/Kolkata' },
    });
    expect(f.me.tasks?.dueToday).toBe(1);
    expect(f.notTracked).toContain('payments');
  });

  it('someone who sees only their own work: no business figures — their tasks, mailbox and calls', async () => {
    const { service, emails } = build(false);
    const f = await service.build({ ...who, roles: ['agent_user'] }, {}, at);
    expect(f.person.sees).toBe('own_work');
    expect(f.businesses).toEqual([]);
    expect(f.attention).toEqual([]);
    expect(f.teamNeedsSupport).toEqual([]);
    expect(f.me).toMatchObject({ emailsWaitingForMyReply: 5, myCallsToday: { total: 2, missed: 1 } });
    // Nobody to suggest tasks for: they can't give tasks.
    expect(f.actionPeople).toEqual([]);
    expect(emails.businessInboxCounts).toHaveBeenCalledWith('b1', at, who.sub);
  });

  it('what the person doesn’t follow is left out — figures, attention lines and the lookups behind them', async () => {
    const { service, activity } = build(true);
    const f = await service.build(who, { metrics: { revenue: false, emails: false, syncHealth: false, tasks: false, team: false } }, at);
    expect(f.businesses[0]).not.toHaveProperty('revenueThisMonth');
    expect(f.businesses[0]).not.toHaveProperty('dealsThisMonth');
    expect(f.businesses[0]).not.toHaveProperty('inbox');
    expect(f.businesses[0]).not.toHaveProperty('problems');
    expect(f.businesses[0]).toMatchObject({ openPipeline: { deals: 17 }, quotesAwaitingDecision: { count: 4 }, callsToday: { total: 4 } });
    // A lapsed subscription is always said; the mailbox and inbox lines aren't.
    expect(f.attention).toEqual(['T.Nagar: No active subscription — its team can only open Billing.']);
    expect(f.me.tasks).toBeUndefined();
    expect(activity.myTasks).not.toHaveBeenCalled();
    expect(f.teamNeedsSupport).toEqual([]);
  });

  it('the person’s own questions, or none at all', async () => {
    const { service } = build(true);
    expect((await service.build(who, { questions: ['Which quotes are waiting?'] }, at)).questions).toEqual(['Which quotes are waiting?']);
    expect((await service.build(who, { questions: [] }, at)).questions).toEqual([]);
    expect((await service.build(who, {}, at)).questions).toEqual(DEFAULT_QUESTIONS);
  });

  it('a store manager: their team’s support lines, not the business’s revenue', async () => {
    const f = await build(true, { storeId: 'store-1' }).service.build({ ...who, roles: ['manager'] }, {}, at);
    expect(f.person.sees).toBe('store_team');
    expect(f.businesses).toEqual([]);
    expect(f.teamNeedsSupport).toHaveLength(1);
  });
});
