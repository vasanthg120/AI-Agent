import {
  CallFacts,
  NO_REPORT_AFTER_MS,
  SCORING_GIVES_UP_AFTER_MS,
  STALE_AFTER_MS,
  classifyFailureText,
  describeCall,
  describeReport,
  reachabilityOf,
  startRefusalCode,
} from './call-outcome';

const NOW = new Date('2026-11-04T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function facts(extra: Partial<CallFacts> = {}): CallFacts {
  return { provider: 'plivo', direction: 'outbound', status: 'initiated', createdAt: ago(5_000), ...extra };
}

describe('describeCall — where a call stands, in plain words', () => {
  it('walks an outbound call through its live stages', () => {
    expect(describeCall(facts(), NOW)).toEqual({ stage: 'ringing_agent', message: 'Ringing your phone…' });
    expect(describeCall(facts({ status: 'in_progress', agentAnswered: true }), NOW)).toEqual({ stage: 'connecting_customer', message: 'Connecting the customer…' });
    expect(describeCall(facts({ status: 'in_progress', answeredAt: ago(1_000) }), NOW)).toEqual({ stage: 'in_call', message: 'In call' });
    expect(describeCall(facts({ status: 'completed' }), NOW)).toEqual({ stage: 'ended', message: 'Call ended' });
  });

  it('never leaves a call "ringing" forever: no word from the carrier means calling is offline', () => {
    const outcome = describeCall(facts({ createdAt: ago(NO_REPORT_AFTER_MS + 1) }), NOW);
    expect(outcome.stage).toBe('failed');
    expect(outcome.failure).toBe('offline');
    expect(describeCall(facts({ createdAt: ago(NO_REPORT_AFTER_MS - 1) }), NOW).stage).toBe('ringing_agent');
  });

  it('ends a call still "in progress" past the carriers\' own limit', () => {
    expect(describeCall(facts({ status: 'in_progress', createdAt: ago(STALE_AFTER_MS + 1) }), NOW).stage).toBe('ended');
  });

  it('uses the recorded failure code first', () => {
    expect(describeCall(facts({ status: 'busy', failureCode: 'busy' }), NOW)).toEqual({
      stage: 'failed',
      failure: 'busy',
      message: "The customer's line was busy.",
    });
    expect(describeCall(facts({ status: 'no_answer', failureCode: 'no_answer_agent' }), NOW).message).toBe(
      "Your phone wasn't answered, so the customer wasn't called.",
    );
    expect(describeCall(facts({ status: 'failed', failureCode: 'balance', provider: 'twilio' }), NOW).message).toMatch(/calling balance on the Twilio account/);
  });

  it('shows an older busy call as busy, not "Call ended" (the bug the agent leg caused)', () => {
    const outcome = describeCall(facts({ status: 'completed', failureReason: 'Call busy.', agentAnswered: true }), NOW);
    expect(outcome).toMatchObject({ stage: 'failed', failure: 'busy' });
    expect(describeCall(facts({ status: 'completed', failureReason: 'Call no answer.', agentAnswered: true }), NOW).failure).toBe('no_answer_customer');
  });

  it("tells whose phone wasn't answered on older calls", () => {
    // Plivo: our Answer webhook never ran (no call id stored).
    expect(describeCall(facts({ status: 'no_answer', agentAnswered: false }), NOW).failure).toBe('no_answer_agent');
    expect(describeCall(facts({ status: 'no_answer', agentAnswered: true }), NOW).failure).toBe('no_answer_customer');
    // Twilio said so in words.
    expect(
      describeCall(facts({ provider: 'twilio', status: 'no_answer', failureReason: 'Your phone was not answered, so the customer was not called.' }), NOW).failure,
    ).toBe('no_answer_agent');
  });

  it('names failures from the carrier\'s own wording', () => {
    expect(describeCall(facts({ status: 'failed', failureReason: 'Plivo: Insufficient balance' }), NOW).failure).toBe('balance');
    expect(describeCall(facts({ status: 'failed', failureReason: 'That phone number is not valid. Check the country code and the number.' }), NOW).failure).toBe(
      'invalid_number',
    );
    expect(describeCall(facts({ status: 'failed', failureReason: 'Plivo: something odd' }), NOW)).toEqual({
      stage: 'failed',
      failure: 'provider_error',
      message: 'Plivo: something odd',
    });
    expect(describeCall(facts({ status: 'cancelled' }), NOW).failure).toBe('cancelled');
  });

  it('words an inbound call from the agent\'s side', () => {
    expect(describeCall(facts({ direction: 'inbound', status: 'in_progress' }), NOW).message).toBe('Ringing your phone…');
    expect(describeCall(facts({ direction: 'inbound', status: 'busy' }), NOW).message).toBe('Your phone was busy.');
  });
});

describe('classifyFailureText', () => {
  it.each([
    ['Plivo: Insufficient balance', 'balance'],
    ['Error Reaching Answer URL', 'offline'],
    ['UNALLOCATED_NUMBER', 'invalid_number'],
    ['INVALID_NUMBER_FORMAT', 'invalid_number'],
    ['That phone number cannot be reached.', 'invalid_number'],
    ['Normal Hangup', undefined],
    [undefined, undefined],
  ])('%s → %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });
});

describe('describeReport — a call report\'s progress', () => {
  const base = { sessionId: 's1' };

  it('goes transcribing → scoring → ready', () => {
    expect(describeReport({ ...base, status: 'processing', updatedAt: ago(1_000) }, NOW).stage).toBe('transcribing');
    expect(describeReport({ ...base, status: 'ended', endedAt: ago(1_000), headline: 'Pricing call' }, NOW)).toMatchObject({ stage: 'scoring', headline: 'Pricing call' });
    expect(describeReport({ ...base, status: 'ended', coachingGeneratedAt: ago(500), overallScore: 7.5 }, NOW)).toEqual({
      sessionId: 's1',
      stage: 'ready',
      overallScore: 7.5,
      headline: undefined,
    });
  });

  it('never waits for a score forever', () => {
    expect(describeReport({ ...base, status: 'ended', endedAt: ago(SCORING_GIVES_UP_AFTER_MS + 1) }, NOW)).toMatchObject({ stage: 'ready', unscored: true });
    expect(describeReport({ ...base, status: 'processing', updatedAt: ago(60 * 60_000) }, NOW).stage).toBe('failed');
    expect(describeReport({ ...base, status: 'error', errorMessage: 'Insufficient credits to process this recording.' }, NOW)).toMatchObject({
      stage: 'failed',
      error: 'Insufficient credits to process this recording.',
    });
  });
});

describe('startRefusalCode', () => {
  it.each([
    [409, 'A call is already being set up.', 'call_in_progress'],
    [400, 'That is your own number. Enter the customer’s number.', 'own_number'],
    [400, 'You do not have a Plivo line yet. Ask an administrator…', 'no_line'],
    [400, 'Plivo is not connected yet.', 'not_ready'],
    [400, 'Calling is not fully set up: the server has no public address (PLIVO_PUBLIC_BASE_URL).', 'not_ready'],
    [400, 'Plivo: Insufficient balance', 'balance'],
    [400, 'Twilio: weird', 'provider_error'],
  ])('%s %s → %s', (status, message, code) => {
    expect(startRefusalCode(status, message)).toBe(code);
  });
});

describe('reachabilityOf — can the phone network reach us?', () => {
  it('is reachable only when the backend itself answered', () => {
    expect(reachabilityOf({ status: 200, body: { status: 'ok', service: 'backend' } })).toBe('reachable');
    expect(reachabilityOf({ status: 200, body: '<html>a parked domain</html>' })).toBe('unknown');
  });

  it('is unreachable on a clear sign: ngrok offline, nothing listening, a dead proxy', () => {
    expect(reachabilityOf({ status: 404, headers: { 'ngrok-error-code': 'ERR_NGROK_3200' } })).toBe('unreachable');
    expect(reachabilityOf({ status: 404, body: 'The endpoint is offline. ERR_NGROK_3200' })).toBe('unreachable');
    expect(reachabilityOf({ errorCode: 'ECONNREFUSED' })).toBe('unreachable');
    expect(reachabilityOf({ errorCode: 'ENOTFOUND' })).toBe('unreachable');
    expect(reachabilityOf({ status: 502 })).toBe('unreachable');
  });

  it('is unknown when the check itself is inconclusive (never blocks calling on a guess)', () => {
    expect(reachabilityOf({ errorCode: 'ETIMEDOUT' })).toBe('unknown');
    expect(reachabilityOf({ errorCode: 'ECONNABORTED' })).toBe('unknown');
    expect(reachabilityOf({ status: 401 })).toBe('unknown');
  });
});
