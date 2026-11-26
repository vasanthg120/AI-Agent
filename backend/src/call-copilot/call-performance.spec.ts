import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MIN_SCORED_TO_RANK, PerformanceCall, PerformanceOptions, TRAINING, bucketFor, buildCallPerformance, kindOf, scoreOf } from './call-performance';
import { CallCopilotService, callKindMatch } from './call-copilot.service';
import { CallCopilotController } from './call-copilot.controller';
import { CallPerformanceQueryDto } from './dto/call-performance-query.dto';

// The Performance tab's figures: worked out only from saved reviews, out of 10,
// fair (nobody ranked or labelled on too few calls), and scoped to whose calls
// the caller may see. No database: the calls are given.

const ORG = 'org-1';
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-30T23:59:59Z');
let seq = 0;

const cats = (scores: Partial<Record<string, number>>) => Object.entries(scores).map(([key, score]) => ({ key, label: key, score }));

function call(userId: string, score100: number | null, extra: Partial<PerformanceCall> & { at?: string; categories?: Partial<Record<string, number>>; outcome?: string; end?: string; strengths?: string[]; concerns?: number; missed?: string[]; unanswered?: number; unhandled?: number } = {}): PerformanceCall {
  const { at, categories, outcome, end, strengths, concerns, missed, unanswered, unhandled, ...rest } = extra;
  seq += 1;
  return {
    _id: `call-${seq}`,
    organizationId: ORG,
    userId,
    createdAt: at ?? '2026-11-15T10:00:00Z',
    source: 'upload',
    headline: `Call ${seq}`,
    overallScore: score100 === null ? 0 : score100 / 10,
    evaluation:
      score100 === null
        ? null
        : {
            version: 2,
            assessable: true,
            bandLabel: score100 >= 70 ? 'Good' : 'Poor',
            categories: cats(categories ?? {}),
            conclusion: { outcome: outcome ? { result: outcome } : null, strengths: (strengths ?? []).map((text) => ({ text })), nextActions: [] },
            analysis: {
              customerSentiment: end ? { end } : null,
              customerQuestions: Array.from({ length: unanswered ?? 0 }, () => ({ answered: 'no' })),
              objections: Array.from({ length: unhandled ?? 0 }, () => ({ handling: 'not_handled' })),
            },
            challenge: { seriousConcerns: Array.from({ length: concerns ?? 0 }, () => ({})), missedOpportunities: (missed ?? []).map((kind) => ({ kind })) },
          },
    ...rest,
  };
}

const options = (extra: Partial<PerformanceOptions> = {}): PerformanceOptions => ({
  from: FROM,
  to: TO,
  previousFrom: new Date('2026-10-02T00:00:00Z'),
  previousTo: new Date('2026-10-31T23:59:59Z'),
  utcOffsetMinutes: 330,
  names: new Map([
    ['priya', 'Priya'],
    ['ravi', 'Ravi'],
    ['new', 'New Starter'],
  ]),
  businessNames: new Map([[ORG, 'Fully Promoted']]),
  viewer: { organizationId: ORG, userId: 'priya' },
  ...extra,
});

describe('call performance: figures from saved reviews, out of 10', () => {
  it('averages out of 10; a call with no review counts as a call but not in the score', () => {
    const p = buildCallPerformance([call('priya', 80), call('priya', 60), call('priya', null)], [], options());
    expect(p.overview.calls).toBe(3);
    expect(p.overview.analysed).toBe(2);
    expect(p.overview.averageScore).toBe(7);
    expect(scoreOf({ overallScore: 3.4 })).toBe(3.4);
    expect(scoreOf({ overallScore: 0 })).toBeNull();
  });

  it('compares with the previous period only when it had reviewed calls', () => {
    const now = [call('priya', 80), call('priya', 70)];
    expect(buildCallPerformance(now, [], options()).overview.change).toBeNull();
    const p = buildCallPerformance(now, [call('priya', 60, { at: '2026-10-10T10:00:00Z' })], options());
    expect(p.overview.previousAverage).toBe(6);
    expect(p.overview.change).toBe(1.5);
  });

  it('successful calls and customer mood come from the review', () => {
    const p = buildCallPerformance(
      [
        call('priya', 80, { outcome: 'sale_confirmed', end: 'positive' }),
        call('priya', 70, { outcome: 'next_step_agreed', end: 'neutral' }),
        call('priya', 30, { outcome: 'no_progress', end: 'negative' }),
        call('priya', 50, { end: 'weird' }),
      ],
      [],
      options(),
    );
    expect(p.overview.successful).toBe(2);
    expect(p.overview.successRate).toBe(67); // of the 3 calls with an outcome
    expect(p.overview.sentiment).toEqual({ positive: 1, neutral: 1, negative: 1, mixed: 0, unclear: 1 });
  });

  it('an earlier review (no Call Intelligence report) counts in the average but adds no skill scores', () => {
    const legacy: PerformanceCall = { _id: 'old', organizationId: ORG, userId: 'priya', createdAt: '2026-11-12T10:00:00Z', overallScore: 6 };
    const p = buildCallPerformance([legacy, call('priya', 80, { categories: { closure: 8 } })], [], options());
    expect(p.overview.averageScore).toBe(7);
    expect(p.categories).toEqual([{ key: 'closure', label: 'Call closure & next steps', average: 8, calls: 1 }]);
  });
});

describe('fair to people', () => {
  const team = () => [
    // Priya: four reviewed calls, strong.
    ...[82, 78, 74, 80].map((s) => call('priya', s, { categories: { discovery: 8, closure: 6, objection_handling: 4 } })),
    // Ravi: three reviewed calls, weak.
    ...[40, 42, 38].map((s) => call('ravi', s, { categories: { discovery: 3, closure: 4 } })),
    // New starter: one excellent call — not enough to rank or label.
    call('new', 95, { categories: { discovery: 9 } }),
  ];

  it(`ranks only people with ${MIN_SCORED_TO_RANK}+ reviewed calls, and labels nobody on fewer`, () => {
    const p = buildCallPerformance(team(), [], options());
    const by = Object.fromEntries(p.people.map((x) => [x.userId, x]));
    expect(by.priya.rank).toBe(1);
    expect(by.priya.standing).toBe('high');
    expect(by.ravi.rank).toBe(2);
    expect(by.ravi.standing).toBe('coaching');
    expect(by.new.rank).toBeNull();
    expect(by.new.standing).toBe('too_few');
    expect(p.overview.highPerformers).toBe(1);
    expect(p.overview.needCoaching).toBe(1);
    // The ranked come first; the one-call starter is listed after, unranked.
    expect(p.people.map((x) => x.userId)).toEqual(['priya', 'ravi', 'new']);
  });

  it('people with the same average share a place', () => {
    const p = buildCallPerformance([...[70, 70, 70].map((s) => call('priya', s)), ...[70, 70, 70].map((s) => call('ravi', s))], [], options());
    expect(p.people.map((x) => x.rank)).toEqual([1, 1]);
  });

  it('improving / declining needs reviewed calls in both periods and a real change', () => {
    const before = (userId: string, scores: number[]) => scores.map((s) => call(userId, s, { at: '2026-10-15T10:00:00Z' }));
    const p = buildCallPerformance(
      [...[80, 80].map((s) => call('priya', s)), ...[50, 50].map((s) => call('ravi', s)), ...[60, 60].map((s) => call('new', s))],
      [...before('priya', [60, 60]), ...before('ravi', [70, 70]), ...before('new', [58])],
      options(),
    );
    const by = Object.fromEntries(p.people.map((x) => [x.userId, x]));
    expect(by.priya.direction).toBe('improving');
    expect(by.priya.change).toBe(2);
    expect(by.ravi.direction).toBe('declining');
    expect(by.new.direction).toBeNull(); // one call before: too little to call a trend
  });

  it('strengths are skills done well (7+); coaching focus is the weakest, with what to practise', () => {
    const p = buildCallPerformance(team(), [], options());
    const priya = p.people.find((x) => x.userId === 'priya')!;
    expect(priya.strengths.map((s) => s.key)).toEqual(['discovery']);
    expect(priya.focus.map((f) => f.key)).toEqual(['objection_handling', 'closure']);
    expect(priya.focus[0].training).toBe(TRAINING.objection_handling);
    const ravi = p.people.find((x) => x.userId === 'ravi')!;
    expect(ravi.strengths).toEqual([]); // no invented praise for a weak caller
  });

  it('a recurring problem is one on two or more calls', () => {
    const p = buildCallPerformance(
      [
        call('ravi', 40, { missed: ['missing_follow_up', 'unhandled_objection'] }),
        call('ravi', 45, { missed: ['missing_follow_up'] }),
        call('ravi', 50, { missed: ['missed_buying_signal'] }),
      ],
      [],
      options(),
    );
    expect(p.people[0].recurring).toEqual([{ kind: 'missing_follow_up', label: 'No follow-up set', count: 2 }]);
  });

  it('recognition is earned: 8+ with a strength the review found, never for a weak call', () => {
    const p = buildCallPerformance(
      [call('priya', 86, { strengths: ['Answered the MOQ objection with a 200-piece option'] }), call('priya', 85), call('priya', 60, { strengths: ['Polite'] })],
      [],
      options(),
    );
    const r = p.people[0].recognition;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ score: 8.6, text: 'Answered the MOQ objection with a 200-piece option' });
  });

  it('says who is the viewer and who is in their business', () => {
    const p = buildCallPerformance([call('priya', 70), call('ravi', 70, { organizationId: 'org-2' })], [], options());
    const by = Object.fromEntries(p.people.map((x) => [x.userId, x]));
    expect(by.priya).toMatchObject({ isViewer: true, sameBusiness: true });
    expect(by.ravi).toMatchObject({ isViewer: false, sameBusiness: false });
  });
});

describe('calls worth opening', () => {
  const calls = () => [
    call('priya', 34, { concerns: 1, end: 'negative', unanswered: 2, missed: ['missing_follow_up'], categories: { closure: 2 } }),
    call('priya', 62, { concerns: 1 }),
    call('ravi', 91, { strengths: ['Clear next step'] }),
    call('ravi', 72, { unhandled: 1 }),
    call('ravi', 55),
  ];

  it('needs attention: under 5 or a serious concern, worst first, with the reasons', () => {
    const l = buildCallPerformance(calls(), [], options()).lists;
    expect(l.attention.map((c) => c.score)).toEqual([3.4, 6.2]);
    expect(l.attention[0].reasons).toEqual(['Serious concern', 'Scored 3.4/10']);
  });

  it('top calls are 7+ only, best first, with their strength', () => {
    const l = buildCallPerformance(calls(), [], options()).lists;
    expect(l.top.map((c) => c.score)).toEqual([9.1, 7.2]);
    expect(l.top[0].reasons).toEqual(['Clear next step']);
  });

  it('negative customer, unresolved questions/objections and no follow-up are each listed', () => {
    const l = buildCallPerformance(calls(), [], options()).lists;
    expect(l.negative.map((c) => c.score)).toEqual([3.4]);
    expect(l.unresolved.map((c) => c.reasons)).toEqual(expect.arrayContaining([['2 questions unanswered'], ['1 objection not handled']]));
    expect(l.noFollowUp[0].reasons).toEqual(['No follow-up set', 'Closing scored 2/10']);
  });

  it('each call says whose it is and whether it is the viewer’s own', () => {
    const l = buildCallPerformance(calls(), [], options()).lists;
    const ravi = l.top[0];
    expect(ravi).toMatchObject({ ownerName: 'Ravi', businessName: 'Fully Promoted', mine: false });
    expect(l.attention[0].mine).toBe(true);
  });

  it('never more than six in a list', () => {
    const many = Array.from({ length: 12 }, () => call('ravi', 30));
    const l = buildCallPerformance(many, [], options()).lists;
    expect(l.attention).toHaveLength(6);
    expect(l.recent).toHaveLength(6);
  });
});

describe('trend over time', () => {
  it('days for a fortnight, weeks for a month or a quarter, months for a year', () => {
    expect(bucketFor(new Date('2026-11-17'), TO)).toBe('day');
    expect(bucketFor(FROM, TO)).toBe('week');
    expect(bucketFor(new Date('2026-09-01'), TO)).toBe('week');
    expect(bucketFor(new Date('2025-12-01'), TO)).toBe('month');
  });

  it('a call is counted on the viewer’s own day (IST: 20:00 UTC is the next day)', () => {
    // The page sends the viewer's own day bounds: 1–30 November in IST.
    const ist = { from: new Date('2026-10-31T18:30:00Z'), to: new Date('2026-11-30T18:29:59.999Z') };
    const p = buildCallPerformance([call('priya', 70, { at: '2026-11-10T20:00:00Z' })], [], options(ist));
    const point = p.overview.trend.find((t) => t.calls > 0)!;
    expect(point.label).toBe('Wk of 9 Nov'); // Wednesday 11 Nov in IST: the week starting Monday 9 Nov
    expect(point.averageScore).toBe(7);
    expect(p.overview.trend.map((t) => t.label)).toEqual(['Wk of 26 Oct', 'Wk of 2 Nov', 'Wk of 9 Nov', 'Wk of 16 Nov', 'Wk of 23 Nov', 'Wk of 30 Nov']);
    const days = buildCallPerformance([call('priya', 70, { at: '2026-11-10T20:00:00Z' })], [], options({ from: new Date('2026-11-04T18:30:00Z'), to: new Date('2026-11-14T18:29:59Z') }));
    expect(days.overview.trend.find((t) => t.calls > 0)!.label).toBe('11 Nov'); // 20:00 UTC is already the next day in IST
  });

  it('a period with no calls is empty, not zero', () => {
    const p = buildCallPerformance([call('priya', 70)], [], options());
    expect(p.overview.trend.filter((t) => t.calls === 0).every((t) => t.averageScore === null)).toBe(true);
  });

  it('nothing to show: zeros and blanks, never invented figures', () => {
    const p = buildCallPerformance([], [], options());
    expect(p.overview).toMatchObject({ calls: 0, analysed: 0, averageScore: null, change: null, successRate: null });
    expect(p.people).toEqual([]);
  });
});

describe('filters and who may see what', () => {
  it('kind of call: live, phone (Plivo/Twilio recordings) and uploads', () => {
    expect(kindOf({ source: 'live' })).toBe('live');
    expect(kindOf({ source: 'upload', originalFilename: 'plivo-123.mp3' })).toBe('phone');
    expect(kindOf({ source: 'upload', originalFilename: 'meeting.m4a' })).toBe('upload');
    expect(callKindMatch('phone')).toEqual([{ source: 'upload', originalFilename: /^(plivo|twilio)-/ }]);
    expect(callKindMatch()).toEqual([]);
  });

  it('only the documented filter values are accepted', async () => {
    expect(await validate(plainToInstance(CallPerformanceQueryDto, { kind: 'phone', score: 'low', utcOffsetMinutes: '330', dateFrom: '2026-11-01T00:00:00.000Z' }))).toHaveLength(0);
    for (const bad of [{ kind: 'fax' }, { score: 'none' }, { utcOffsetMinutes: '9999' }, { dateFrom: 'yesterday' }, { scope: 'everyone' }]) {
      expect((await validate(plainToInstance(CallPerformanceQueryDto, bad))).length).toBeGreaterThan(0);
    }
  });

  describe('the route', () => {
    const user = { sub: 'priya', organizationId: ORG } as never;
    let calls: { getPerformance: jest.Mock };
    let scopes: { resolve: jest.Mock; pick: jest.Mock; people: jest.Mock; describeOwner: jest.Mock };
    let controller: CallCopilotController;

    beforeEach(() => {
      calls = { getPerformance: jest.fn(async () => ({})) };
      scopes = {
        resolve: jest.fn(async () => ({ team: false })),
        pick: jest.fn((_scope, id?: string) => [{ id: ORG, name: 'Fully Promoted' }].filter((b) => !id || b.id === id)),
        people: jest.fn(async () => [
          { id: 'priya', name: 'Priya', department: 'Sales' },
          { id: 'ravi', name: 'Ravi', department: 'Sales' },
          { id: 'sam', name: 'Sam', department: 'Support' },
        ]),
        describeOwner: jest.fn(async () => ({ ownerName: 'Priya', businessName: 'Fully Promoted' })),
      };
      controller = new CallCopilotController(calls as never, {} as never, {} as never, scopes as never, {} as never);
    });

    it('someone who only sees their own calls gets their own, even when asking for the team', async () => {
      await controller.performance(user, { scope: 'team', userId: 'ravi' } as never);
      expect(calls.getPerformance.mock.calls[0][0]).toEqual({ organizationId: ORG, userId: 'priya' });
    });

    it('a manager gets the team they may see; a team (department) narrows it', async () => {
      scopes.resolve.mockResolvedValue({ team: true });
      await controller.performance(user, { scope: 'team', department: 'sales' } as never);
      expect(calls.getPerformance.mock.calls[0][0]).toEqual({ $or: [{ organizationId: ORG, userId: { $in: ['priya', 'ravi'] } }] });
      const context = calls.getPerformance.mock.calls[0][2];
      expect(context.names.get('ravi')).toBe('Ravi');
      expect(context.viewer).toEqual({ organizationId: ORG, userId: 'priya' });
    });

    it('a person outside the caller’s reach matches nothing', async () => {
      scopes.resolve.mockResolvedValue({ team: true });
      await controller.performance(user, { scope: 'team', userId: 'stranger' } as never);
      expect(calls.getPerformance.mock.calls[0][0]).toEqual({ _id: null });
    });
  });

  it('the service reads only the review fields, newest first, for this period and the one before', async () => {
    const find = jest.fn(() => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }), limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }));
    const service = new CallCopilotService({ find } as never, {} as never, {} as never, { get: () => undefined } as never, {} as never, {} as never);
    const result = await service.getPerformance({ organizationId: ORG, userId: 'priya' }, { dateFrom: FROM.toISOString(), dateTo: TO.toISOString(), kind: 'live' } as never, {
      names: new Map(),
      businessNames: new Map(),
      viewer: { organizationId: ORG, userId: 'priya' },
    });
    const [now, before] = find.mock.calls.map((c) => (c as unknown as [{ $and: Record<string, unknown>[] }])[0].$and);
    expect(now).toEqual(expect.arrayContaining([{ organizationId: ORG, userId: 'priya' }, { $or: [{ source: 'live' }, { source: { $exists: false } }] }, { createdAt: { $gte: FROM, $lte: TO } }]));
    expect(before).toEqual(expect.arrayContaining([{ overallScore: { $gt: 0 } }]));
    expect(result.overview.calls).toBe(0);
  });

  it('a start date after the end date is refused', async () => {
    const service = new CallCopilotService({ find: jest.fn() } as never, {} as never, {} as never, { get: () => undefined } as never, {} as never, {} as never);
    await expect(
      service.getPerformance({}, { dateFrom: TO.toISOString(), dateTo: FROM.toISOString() } as never, { names: new Map(), businessNames: new Map(), viewer: { organizationId: ORG, userId: 'priya' } }),
    ).rejects.toThrow('The start date is after the end date.');
  });
});
