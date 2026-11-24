import { AxiosError, AxiosHeaders } from 'axios';
import { Subject, of, throwError } from 'rxjs';
import { CallCopilotService, coachingInProgress } from './call-copilot.service';
import { AI_REPORT_TIMEOUT_MS, COACHING_ABANDONED_AFTER_MS, describeCoachingFailure } from './processing-failure';
import { callDurationSeconds, recordingCategory, speakersSeparated, transcriptLines } from './call-intelligence';

// The AI Coach on a long call: a review takes over a minute, so the button
// starts it in the background, a second press joins it instead of paying
// twice, a failure is kept on the call in words, and python-agent is given
// minutes (not the module's 60 s) to answer. No database or python-agent.

type Stored = { coachingStartedAt?: Date; coachingError?: string };
type Session = Record<string, unknown> & Stored & { _id: { toString(): string }; save: jest.Mock };

// What python-agent's /call-copilot/evaluate answers: the Call Intelligence report, and the same in the earlier fields.
const COACH_REPLY = {
  evaluation: { version: 2, assessable: true, score: 70, band: 'good', bandLabel: 'Good', coverage: 100, categories: [] },
  categoryScores: [
    { category: 'discovery', score: 8, rationale: 'x' },
    { category: 'closure', score: 6, rationale: 'y' },
  ],
  overallScore: 7,
  whatWentWell: ['a'],
  whatToImprove: ['b'],
  whatWouldHaveDoneDifferently: ['c'],
  nextCallFocus: ['d'],
  keyMoments: [{ momentType: 'missed_opportunity', text: 'Price question left hanging', recommendation: 'Answer it', at: 95 }],
  coachingSummary: 'Good call.',
  voiceScript: 'Nice work.',
};

function makeSession(fields: Partial<Session> = {}): Session {
  return {
    _id: { toString: () => 'session-1' },
    organizationId: 'org-1',
    userId: 'user-1',
    status: 'ended',
    source: 'upload',
    transcript: [],
    events: [],
    summaryPoints: [],
    keyTakeaways: [],
    voiceScripts: [],
    save: jest.fn(async () => undefined),
    ...fields,
  };
}

describe('AI Coach runs on long calls', () => {
  let stored: Stored;
  let sessionModel: { updateOne: jest.Mock; findById: jest.Mock };
  let http: { post: jest.Mock };
  let service: CallCopilotService;

  beforeEach(() => {
    stored = {};
    // updateOne behaves like Mongo's: the claim only lands if coachingStartedAt is still what the caller read.
    sessionModel = {
      updateOne: jest.fn((filter: { coachingStartedAt: Date | null }, update: { $set: Stored }) => ({
        exec: async () => {
          const current = stored.coachingStartedAt ?? null;
          const matches = (current?.getTime() ?? null) === (filter.coachingStartedAt?.getTime() ?? null);
          if (!matches) return { modifiedCount: 0 };
          stored = { coachingStartedAt: update.$set.coachingStartedAt };
          return { modifiedCount: 1 };
        },
      })),
      findById: jest.fn(() => ({ select: () => ({ exec: async () => ({ ...stored }) }) })),
    };
    http = { post: jest.fn(() => of({ data: COACH_REPLY })) };
    service = new CallCopilotService(
      sessionModel as never,
      http as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('the button answers at once and the review finishes in the background', async () => {
    const pending = new Subject<{ data: typeof COACH_REPLY }>();
    http.post.mockReturnValueOnce(pending.asObservable());
    const session = makeSession();

    const reply = await service.requestCoaching(session as never, 'a ten minute conversation');
    expect(reply.status).toBe('generating');
    expect(reply.startedAt).toEqual(stored.coachingStartedAt);
    expect(session.coachingGeneratedAt).toBeUndefined(); // not waited for

    pending.next({ data: COACH_REPLY });
    pending.complete();
    await flush();
    expect(session.overallScore).toBe(7);
    expect((session.coachingGeneratedAt as Date).getTime()).toBeGreaterThanOrEqual(reply.startedAt.getTime());
    expect(session.save).toHaveBeenCalled();
  });

  it('gives python-agent the long-report time limit, not the 60 s default', async () => {
    await service.requestCoaching(makeSession() as never, 'words');
    await flush();
    const [url, , options] = http.post.mock.calls[0];
    expect(url).toMatch(/\/call-copilot\/evaluate$/);
    expect(options.timeout).toBe(AI_REPORT_TIMEOUT_MS);
    expect(AI_REPORT_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('a second press while a review is running joins it — one paid run', async () => {
    http.post.mockReturnValueOnce(new Subject().asObservable()); // never answers
    const first = await service.requestCoaching(makeSession() as never, 'words');
    const second = await service.requestCoaching(makeSession({ coachingStartedAt: stored.coachingStartedAt }) as never, 'words');
    expect(second.startedAt).toEqual(first.startedAt);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a double click from two stale reads still starts only one run', async () => {
    http.post.mockReturnValue(new Subject().asObservable());
    const [a, b] = await Promise.all([
      service.requestCoaching(makeSession() as never, 'words'),
      service.requestCoaching(makeSession() as never, 'words'),
    ]);
    expect(a.startedAt).toEqual(b.startedAt);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a timeout is kept on the call in plain words, so the panel can say it', async () => {
    const config = { url: 'http://localhost:8000/call-copilot/coach', headers: new AxiosHeaders() };
    http.post.mockReturnValueOnce(throwError(() => new AxiosError('timeout of 300000ms exceeded', 'ECONNABORTED', config)));
    const session = makeSession();
    await service.requestCoaching(session as never, 'words');
    await flush();
    expect(session.coachingError).toMatch(/took too long/);
    expect(session.coachingGeneratedAt).toBeUndefined();
    expect(session.save).toHaveBeenCalled();
  });

  it('the automatic run after a call skips if the button already started one', async () => {
    stored = { coachingStartedAt: new Date() };
    const ended = makeSession(); // read before the button was pressed
    await service.generateCoaching(ended as never, 'words');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('an empty transcript is never sent for coaching', async () => {
    await service.generateCoaching(makeSession() as never, '   ');
    expect(sessionModel.updateOne).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe('coachingInProgress', () => {
  const started = new Date('2026-11-14T10:00:00Z');
  const now = started.getTime() + 30_000;

  it('is running between start and a report or an error', () => {
    expect(coachingInProgress({ coachingStartedAt: started }, now)).toBe(true);
    expect(coachingInProgress({ coachingStartedAt: started, coachingGeneratedAt: new Date(now) }, now)).toBe(false);
    expect(coachingInProgress({ coachingStartedAt: started, coachingError: 'x' }, now)).toBe(false);
    expect(coachingInProgress({}, now)).toBe(false);
  });

  it('an older report does not count as this run finishing', () => {
    expect(coachingInProgress({ coachingStartedAt: started, coachingGeneratedAt: new Date(started.getTime() - 1) }, now)).toBe(true);
  });

  it('a run nobody finished (server restarted) stops blocking a new one', () => {
    expect(coachingInProgress({ coachingStartedAt: started }, started.getTime() + COACHING_ABANDONED_AFTER_MS + 1)).toBe(false);
  });
});

describe('describeCoachingFailure', () => {
  const axiosError = (options: { status?: number; code?: string; detail?: string }) => {
    const config = { url: 'http://localhost:8000/call-copilot/coach', headers: new AxiosHeaders() };
    const data = options.detail ? { detail: options.detail } : 'Internal Server Error';
    const response = options.status === undefined ? undefined : { status: options.status, statusText: '', headers: {}, config, data };
    return new AxiosError('Request failed', options.code, config, undefined, response as never);
  };

  it('words each failure for the salesperson, never "status code 500"', () => {
    expect(describeCoachingFailure(axiosError({ code: 'ECONNABORTED' })).message).toMatch(/took too long/);
    expect(describeCoachingFailure(axiosError({ code: 'ECONNREFUSED' })).message).toMatch(/AI service isn’t running/);
    expect(describeCoachingFailure(axiosError({ status: 500 })).message).toBe('The AI Coach couldn’t review this call right now. Try again in a minute.');
    expect(describeCoachingFailure(axiosError({ status: 503, detail: 'Anthropic is busy' })).message).toBe('Anthropic is busy.');
  });

  it('keeps the technical reason for the log', () => {
    expect(describeCoachingFailure(axiosError({ status: 500 })).technical).toBe('HTTP 500 from http://localhost:8000/call-copilot/coach');
  });
});

// Call Intelligence: a live call, an uploaded recording and a phone call recorded
// through Call Copilot all go through the same evaluation — the transcript as
// numbered lines with when each was said and by whom, never one run-on string.
describe('Call Intelligence: one evaluation for every kind of recording', () => {
  const start = new Date('2026-11-20T10:00:00Z');
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  const seg = (sequence: number, text: string, extra: Record<string, unknown> = {}) => ({ sequence, text, audioFileId: 'f', recordedAt: at(0), ...extra });

  const upload = {
    source: 'upload' as const,
    originalFilename: 'call-with-priya.mp3',
    createdAt: start,
    transcript: [
      seg(1, 'We need 200 polo shirts for March.', { speaker: '1', startSeconds: 6.2, endSeconds: 12 }),
      seg(0, 'Hi, this is Priya from Fully Promoted.', { speaker: '0', startSeconds: 0, endSeconds: 5.5 }),
      seg(2, '', { speaker: '0', startSeconds: 12, endSeconds: 13 }),
    ],
  };
  const live = {
    source: 'live' as const,
    createdAt: start,
    endedAt: at(70),
    // Each piece arrives as it is recorded: the next one starts when the previous arrived.
    transcript: [seg(0, 'Hello, thanks for calling.', { recordedAt: at(20) }), seg(1, 'I wanted a quote.', { recordedAt: at(41) }), seg(2, 'Sure, for how many?', { recordedAt: at(62) })],
  };

  it('which kind of recording a call is', () => {
    expect(recordingCategory({ source: 'live' })).toBe('live');
    expect(recordingCategory({ source: 'upload', originalFilename: 'plivo-abc.mp3' })).toBe('phone');
    expect(recordingCategory({ source: 'upload', originalFilename: 'twilio-RE12.wav' })).toBe('phone');
    expect(recordingCategory({ source: 'upload', originalFilename: 'meeting.m4a' })).toBe('upload');
  });

  it('an uploaded or phone recording: in order, with Sarvam’s start times and speakers; silence left out', () => {
    expect(transcriptLines(upload)).toEqual([
      { id: 'L1', at: 0, speaker: '0', text: 'Hi, this is Priya from Fully Promoted.' },
      { id: 'L2', at: 6.2, speaker: '1', text: 'We need 200 polo shirts for March.' },
    ]);
    expect(speakersSeparated(upload)).toBe(true);
    expect(callDurationSeconds(upload)).toBe(13);
  });

  it('a live call: each piece timed from the start of the call; one microphone, so no speakers', () => {
    expect(transcriptLines(live).map((l) => [l.id, l.at, l.speaker])).toEqual([
      ['L1', 0, null],
      ['L2', 20, null],
      ['L3', 41, null],
    ]);
    expect(speakersSeparated(live)).toBe(false);
    expect(callDurationSeconds(live)).toBe(70);
  });

  it('one long piece (no speaker separation) is cut into lines a quote can point to', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about polo shirts and pricing.`).join(' ');
    const lines = transcriptLines({ source: 'upload', createdAt: start, transcript: [seg(0, long)] });
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((l) => l.text.split(/\s+/).length <= 70)).toBe(true);
    expect(lines.map((l) => l.text).join(' ')).toBe(long);
  });

  describe('the review sent and kept, for each kind', () => {
    let http: { post: jest.Mock };
    let service: CallCopilotService;
    const claimFree = { updateOne: jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) })), findById: jest.fn() };

    beforeEach(() => {
      http = { post: jest.fn(() => of({ data: COACH_REPLY })) };
      service = new CallCopilotService(claimFree as never, http as never, { sign: () => 'token' } as never, { get: () => undefined } as never, {} as never, {} as never);
    });

    const cases: [string, Record<string, unknown>, string, boolean][] = [
      ['live call', live, 'live', false],
      ['uploaded recording', upload, 'upload', true],
      ['phone call', { ...upload, originalFilename: 'plivo-7f3.mp3' }, 'phone', true],
    ];
    it.each(cases)('%s', async (_name, fields, category, separated) => {
      const session = makeSession(fields as Partial<Session>);
      const coached = (await service.generateCoaching(session as never, 'ignored')) as unknown as Session;
      const [url, body] = http.post.mock.calls[0];
      expect(url).toMatch(/\/call-copilot\/evaluate$/);
      expect(body.meta).toMatchObject({ category, speakersSeparated: separated });
      expect(body.lines[0]).toMatchObject({ id: 'L1', at: 0 });
      expect(body).not.toHaveProperty('fullTranscript');
      // The full report is kept on the call; every list keeps reading the score out of 10.
      expect(coached.evaluation).toEqual(COACH_REPLY.evaluation);
      expect([coached.score100, coached.scoreBand, coached.overallScore]).toEqual([70, 'good', 7]);
      // A moment's time is its line's, shown as time into the call.
      const moment = (coached.keyMoments as { occurredAt: Date }[])[0];
      expect(moment.occurredAt.getTime() - start.getTime()).toBe(95_000);
    });

    it('too little conversation to judge: kept as "not scored" (0), not as a low score', async () => {
      http.post.mockReturnValueOnce(of({ data: { ...COACH_REPLY, evaluation: { ...COACH_REPLY.evaluation, assessable: false, score: null, band: 'not_assessable' }, overallScore: null, categoryScores: [] } }));
      const coached = (await service.generateCoaching(makeSession(upload as never) as never, 'x')) as unknown as Session;
      expect([coached.overallScore, coached.score100, coached.scoreBand]).toEqual([0, undefined, 'not_assessable']);
    });
  });
});
