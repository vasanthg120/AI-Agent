import { AxiosError, AxiosHeaders } from 'axios';
import { Subject, of, throwError } from 'rxjs';
import { CallCopilotService, coachingInProgress } from './call-copilot.service';
import { AI_REPORT_TIMEOUT_MS, COACHING_ABANDONED_AFTER_MS, describeCoachingFailure } from './processing-failure';

// The AI Coach on a long call: a review takes over a minute, so the button
// starts it in the background, a second press joins it instead of paying
// twice, a failure is kept on the call in words, and python-agent is given
// minutes (not the module's 60 s) to answer. No database or python-agent.

type Stored = { coachingStartedAt?: Date; coachingError?: string };
type Session = Record<string, unknown> & Stored & { _id: { toString(): string }; save: jest.Mock };

const COACH_REPLY = {
  categoryScores: [
    { category: 'opening_rapport', score: 8, rationale: 'x' },
    { category: 'closing_followup', score: 6, rationale: 'y' },
  ],
  whatWentWell: ['a'],
  whatToImprove: ['b'],
  whatWouldHaveDoneDifferently: ['c'],
  nextCallFocus: ['d'],
  keyMoments: [],
  coachingSummary: 'Good call.',
  voiceScript: 'Nice work.',
};

function makeSession(fields: Partial<Session> = {}): Session {
  return {
    _id: { toString: () => 'session-1' },
    organizationId: 'org-1',
    userId: 'user-1',
    status: 'ended',
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
    expect(url).toMatch(/\/call-copilot\/coach$/);
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
    http.post.mockReturnValueOnce(
      throwError(() => new AxiosError('timeout of 300000ms exceeded', 'ECONNABORTED', { url: 'http://localhost:8000/call-copilot/coach', headers: new AxiosHeaders() })),
    );
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
    const response =
      options.status === undefined ? undefined : { status: options.status, statusText: '', headers: {}, config, data: options.detail ? { detail: options.detail } : 'Internal Server Error' };
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
