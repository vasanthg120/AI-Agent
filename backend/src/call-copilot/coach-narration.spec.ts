import { AxiosError, AxiosHeaders } from 'axios';
import { BadGatewayException, BadRequestException, GatewayTimeoutException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of, throwError } from 'rxjs';
import { MAX_SPOKEN_PART, buildCoachNarration, narrationKey, narrationParts, splitForSpeech, spokenTime } from './coach-narration';
import { CallCopilotController } from './call-copilot.controller';
import { CallCopilotService } from './call-copilot.service';
import { VoiceScriptDto } from './dto/voice-script.dto';
import { VOICE_LANGUAGE_CODES } from '../voice/dto/voice-languages';

// The AI Coach's spoken narration: the whole report read out, built from the
// report saved on the call (never a fixed script), in every language the panel
// offers, cached per language and report version. No database, python-agent or
// voice provider: those are stood in for.

const speakers = [
  { label: 'Speaker 1', role: 'agent', basis: 'introduces herself' },
  { label: 'Speaker 2', role: 'customer', basis: 'states the need' },
];

const category = (key: string, label: string, score: number | null, rationale: string, notAssessableReason = '') => ({
  key,
  label,
  weight: 10,
  assessable: score !== null,
  score,
  rationale,
  notAssessableReason,
  evidence: [],
});

/** Call A: 34/100, Critical. The customer's need was already met elsewhere, an MOQ objection, no next step. */
const CALL_A = {
  version: 2,
  assessable: true,
  score: 34,
  band: 'critical',
  bandLabel: 'Critical',
  coverage: 80,
  lowCoverage: false,
  categories: [
    category('discovery', 'Requirement Understanding & Discovery', 3, 'Never asked what the customer still needed after hearing the order was placed elsewhere.'),
    category('objection_handling', 'Objection Handling', 2, 'The MOQ objection of 500 pieces was met with silence.'),
    category('closure', 'Call Closure & Next Steps', 1, 'The call ended with no follow-up or date.'),
    category('product_knowledge', 'Product / Service Knowledge', null, '', 'The customer never asked about the product.'),
  ],
  understanding: { callPurpose: 'Follow up a hoodie quote', context: '', speakers, customerRequirements: [] },
  analysis: {
    customerQuestions: [{ question: 'Can you go below 500 pieces?', answered: 'no', at: 48 }],
    objections: [{ objection: 'Your MOQ of 500 is too high', handling: 'not_handled', how: 'The agent moved on without an answer.', at: 52 }],
    buyingSignals: [],
    commitments: [],
    communicationIssues: [],
    customerEngagement: { level: 'low', basis: 'Short answers throughout.' },
    customerSentiment: { start: 'neutral', end: 'negative', basis: 'Ends the call quickly.' },
  },
  challenge: {
    missedOpportunities: [
      {
        kind: 'unhandled_objection',
        text: 'The MOQ objection could have been met with a smaller first run',
        betterApproach: 'Offer a 200-piece trial order at the same unit price',
        evidence: { lineId: 'L9', quote: 'Your MOQ of 500 is too high', at: 52, speaker: 'Speaker 2' },
        at: 52,
      },
    ],
    seriousConcerns: [
      {
        kind: 'requirement_fulfilled',
        text: 'The customer had already bought from Acme Prints and the agent kept pitching',
        evidence: { lineId: 'L4', quote: 'We already got them from Acme Prints last week', at: 65, speaker: 'Speaker 2' },
      },
    ],
    expertWouldHaveDone: [],
  },
  conclusion: {
    outcome: { result: 'no_progress', explanation: 'Nothing was agreed.', performanceVsOutcome: 'Poor handling made a hard call worse.' },
    verdict: 'The agent missed that the need was already met and left the MOQ objection unanswered.',
    summaryForAgent: '',
    strengths: [{ text: 'Opened politely and used the customer’s name', evidence: { lineId: 'L1', quote: 'Hi Ravi', at: 2, speaker: 'Speaker 1' } }],
    weaknesses: [
      { text: 'Kept pitching after hearing the order was placed elsewhere', severity: 'critical', impact: 'The customer disengaged.', evidence: null },
      { text: 'Talked over the customer twice', severity: 'minor', impact: '', evidence: null },
    ],
    coaching: [
      { change: 'Stop and re-qualify when a customer says the need is met', how: 'Ask what comes next for them instead of pitching.', example: 'Glad you’re sorted, Ravi. What’s your next event?' },
    ],
    nextActions: [{ text: 'Email Ravi a 200-piece MOQ option', owner: 'agent', priority: 'high', basis: 'MOQ was the stated blocker.' }],
  },
  qa: { reviewed: true, quotesChecked: 4, quotesDropped: 0, checks: [], adjustments: [{ category: null, from: 41, to: 34, by: 'rule', reason: 'A serious concern caps the total.' }] },
};

/** Call B: 73/100, Good. The customer is comparing prices and will decide tomorrow. */
const CALL_B = {
  ...CALL_A,
  score: 73,
  band: 'good',
  bandLabel: 'Good',
  categories: [
    category('discovery', 'Requirement Understanding & Discovery', 8, 'Asked about quantity, colours and the event date.'),
    category('value_proposition', 'Persuasion & Value Proposition', 7, 'Explained why embroidery lasts longer than print.'),
  ],
  analysis: {
    ...CALL_A.analysis,
    customerQuestions: [],
    objections: [{ objection: 'Another supplier is cheaper', handling: 'well', how: 'Compared durability.', at: 30 }],
    commitments: [{ by: 'customer', text: 'Will give a final decision tomorrow by 11 am', realistic: true, at: 140 }],
    customerEngagement: { level: 'high', basis: 'Asked many questions.' },
    customerSentiment: { start: 'neutral', end: 'positive', basis: 'Thanks the agent warmly.' },
  },
  challenge: { missedOpportunities: [], seriousConcerns: [], expertWouldHaveDone: [] },
  conclusion: {
    outcome: { result: 'next_step_agreed', explanation: 'Decision call set for tomorrow.', performanceVsOutcome: 'A good call that earned a clear next step.' },
    verdict: 'A confident call against a price comparison, with a firm decision date.',
    summaryForAgent: '',
    strengths: [{ text: 'Answered the price comparison with durability', evidence: { lineId: 'L5', quote: 'embroidery lasts', at: 31, speaker: 'Speaker 1' } }],
    weaknesses: [{ text: 'Did not confirm the budget', severity: 'major', impact: 'The price may still lose it.', evidence: null }],
    coaching: [{ change: 'Confirm the budget before quoting', how: 'Ask for their range early.', example: 'What range are you working with?' }],
    nextActions: [{ text: 'Call tomorrow at 11 am for the decision', owner: 'agent', priority: 'high', basis: 'The customer committed to deciding tomorrow.' }],
  },
  qa: { reviewed: true, quotesChecked: 3, quotesDropped: 0, checks: [], adjustments: [] },
};

const report = (evaluation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  overallScore: ((evaluation.score as number | null) ?? 0) / 10,
  categoryScores: [],
  evaluation,
  ...extra,
});

const all = (sections: { text: string }[]) => sections.map((s) => s.text).join(' ');

describe('AI Coach narration: the whole report, from the report itself', () => {
  it('reads every section in order: overall, well, improve, skills, concerns, coaching, next steps', () => {
    const sections = buildCoachNarration(report(CALL_A));
    expect(sections.map((s) => s.id)).toEqual(['overview', 'strengths', 'improvements', 'skills', 'concerns', 'coaching', 'next_steps']);
    const text = all(sections);
    // A. overall
    expect(text).toContain('You scored 3.4 out of 10');
    expect(text).toContain('Critical band');
    expect(text).toContain(CALL_A.conclusion.verdict);
    expect(text).toContain('there was no progress');
    // B. strengths
    expect(text).toContain('Opened politely and used the customer’s name');
    // C. weaknesses, worst first, with impact; the unhandled objection and unanswered question
    expect(text.indexOf('A critical issue')).toBeLessThan(text.indexOf('A minor issue'));
    expect(text).toContain('The customer disengaged.');
    expect(text).toContain('“Your MOQ of 500 is too high”, and it was not handled');
    expect(text).toContain('“Can you go below 500 pieces?”, and it was not answered');
    // D. every skill, including one that could not be judged, and why the total was held
    expect(text).toContain('Objection Handling: 2 out of 10. The MOQ objection of 500 pieces was met with silence.');
    expect(text).toContain('Call Closure and Next Steps: 1 out of 10.');
    expect(text).toContain('Product and Service Knowledge: not assessable. The customer never asked about the product.');
    expect(text).toContain('held at 3.4 because a serious concern caps the total');
    // E. serious concern with the words and the time, missed opportunity with the better approach
    expect(text).toContain('The customer had already bought from Acme Prints and the agent kept pitching.');
    expect(text).toContain('At 1 minute 5 seconds into the call, the customer said: “We already got them from Acme Prints last week”.');
    expect(text).toContain('An objection was not handled at 52 seconds');
    expect(text).toContain('Better: Offer a 200-piece trial order at the same unit price.');
    // F. coaching with words to try
    expect(text).toContain('Stop and re-qualify when a customer says the need is met.');
    expect(text).toContain('You could say: “Glad you’re sorted, Ravi. What’s your next event?”');
    expect(text).not.toContain('?”.');
    // G. next steps
    expect(text).toContain('For you, high priority: Email Ravi a 200-piece MOQ option.');
    expect(text).toContain('That is the complete AI Coach review of this call.');
  });

  it('two different calls are narrated differently, each from its own report', () => {
    const a = all(buildCoachNarration(report(CALL_A)));
    const b = all(buildCoachNarration(report(CALL_B)));
    expect(b).toContain('You scored 7.3 out of 10, which puts this call in the Good band.');
    expect(b).toContain('a next step was agreed');
    expect(b).toContain('The customer committed at 2 minutes 20 seconds: Will give a final decision tomorrow by 11 am.');
    expect(b).toContain('Call tomorrow at 11 am for the decision');
    expect(b).not.toContain('Acme Prints');
    expect(b).not.toContain('3.4 out of 10');
    expect(a).not.toContain('decision tomorrow');
    expect(narrationKey(buildCoachNarration(report(CALL_A)))).not.toBe(narrationKey(buildCoachNarration(report(CALL_B))));
  });

  it('the key is stable for one report and changes when the report changes', () => {
    expect(narrationKey(buildCoachNarration(report(CALL_A)))).toBe(narrationKey(buildCoachNarration(report(CALL_A))));
    const rescored = { ...CALL_A, score: 35 };
    expect(narrationKey(buildCoachNarration(report(rescored)))).not.toBe(narrationKey(buildCoachNarration(report(CALL_A))));
  });

  it('a call that could not be scored says so and why, and nothing else', () => {
    const sections = buildCoachNarration(
      report({ version: 2, assessable: false, notAssessableReason: 'Only 12 words were spoken.', score: null, bandLabel: 'Not assessable', categories: [] }),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain('This call could not be scored. Only 12 words were spoken.');
  });

  it('an incomplete report (sections missing) is still read without failing', () => {
    const sections = buildCoachNarration(report({ version: 2, assessable: true, score: 55, bandLabel: 'Poor', categories: [category('closure', 'Call Closure & Next Steps', 5, 'Vague close.')] }));
    const text = all(sections);
    expect(text).toContain('You scored 5.5 out of 10');
    expect(text).toContain('nothing in this call stood out enough');
    expect(text).toContain('Call Closure and Next Steps: 5 out of 10. Vague close.');
    expect(text).toContain('the report lists no next actions');
    expect(sections.map((s) => s.id)).not.toContain('concerns');
  });

  it('an earlier AI Coach report (before Call Intelligence) is read from its own fields', () => {
    const createdAt = new Date('2026-10-01T10:00:00Z');
    const text = all(
      buildCoachNarration({
        overallScore: 6.5,
        categoryScores: [{ category: 'opening_rapport', score: 7, rationale: 'Warm opening.' }],
        whatWentWell: ['Built rapport fast'],
        whatToImprove: ['Ask for the order'],
        whatWouldHaveDoneDifferently: ['Proposed a delivery date'],
        nextCallFocus: ['Close with a date'],
        keyMoments: [{ momentType: 'missed_opportunity', text: 'Price question left hanging', recommendation: 'Answer it', occurredAt: new Date(createdAt.getTime() + 95_000) }],
        coachingSummary: 'Solid but no close.',
        createdAt,
      }),
    );
    expect(text).toContain('You scored 6.5 out of 10, which is rated Fair.');
    expect(text).toContain('Opening and rapport: 7 out of 10. Warm opening.');
    expect(text).toContain('A missed opportunity at 1 minute 35 seconds: Price question left hanging.');
    expect(text).toContain('Close with a date.');
  });

  it('says times the way a person would', () => {
    expect(spokenTime(5)).toBe('5 seconds');
    expect(spokenTime(60)).toBe('1 minute');
    expect(spokenTime(125)).toBe('2 minutes 5 seconds');
    expect(spokenTime(null)).toBeNull();
  });
});

describe('long narration is split for the voice without cutting a sentence', () => {
  it('keeps every part under the limit, ending at a sentence, and loses no words', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Point ${i + 1} scored 7.5 out of 10 for a clear reason.`).join(' ');
    const parts = splitForSpeech(text, 300);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p).toMatch(/\.$/);
    }
    expect(parts.join(' ')).toBe(text);
    // A decimal is not a sentence end.
    expect(parts.some((p) => /^5 out of 10/.test(p))).toBe(false);
  });

  it('splits Indian-language text at its own full stop (danda)', () => {
    const hindi = Array.from({ length: 40 }, (_, i) => `यह बिंदु ${i + 1} है।`).join(' ');
    const parts = splitForSpeech(hindi, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p).toMatch(/।$/);
    expect(parts.join(' ')).toBe(hindi);
  });

  it('a single sentence over the limit is broken at a comma, never mid-word', () => {
    const long = `${Array.from({ length: 30 }, (_, i) => `item number ${i}`).join(', ')}.`;
    const parts = splitForSpeech(long, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ')).toBe(long);
  });

  it('a full report becomes parts in section order, each within /voice/speak’s limit', () => {
    const sections = buildCoachNarration(report(CALL_A));
    const parts = narrationParts(sections);
    expect(parts.map((p) => p.sectionId).filter((id, i, a) => a.indexOf(id) === i)).toEqual(sections.map((s) => s.id));
    expect(parts.every((p) => p.text.length <= MAX_SPOKEN_PART && MAX_SPOKEN_PART < 2500)).toBe(true);
    expect(parts.map((p) => p.text).join(' ')).toBe(sections.map((s) => s.text).join(' '));
  });
});

// ---- the service: languages, cache, failures ----

type Session = Record<string, unknown> & { _id: { toString(): string }; voiceScripts: Record<string, unknown>[] };

function makeSession(fields: Partial<Session> = {}): Session {
  return {
    _id: { toString: () => 'session-1' },
    organizationId: 'org-1',
    userId: 'user-1',
    overallScore: 3.4,
    categoryScores: [],
    evaluation: CALL_A,
    coachingGeneratedAt: new Date('2026-11-20T10:00:00Z'),
    voiceScripts: [],
    ...fields,
  };
}

/** python-agent's answer: each section "translated" (tagged with the language so a mix-up shows). */
function translatedReply(body: { languageCode: string; sections: { id: string; title: string; text: string }[] }) {
  return of({ data: { languageCode: body.languageCode, sections: body.sections.map((s) => ({ ...s, text: `[${body.languageCode}] ${s.text}` })) } });
}

function axiosError(status: number | undefined, detail?: string, code?: string): AxiosError {
  const config = { headers: new AxiosHeaders(), url: 'http://localhost:8000/call-copilot/voice-script' };
  return new AxiosError(
    'failed',
    code,
    config,
    {},
    status ? { status, statusText: '', data: detail ? { detail } : {}, headers: {}, config } : undefined,
  );
}

describe('CallCopilotService.getCoachNarration', () => {
  let http: { post: jest.Mock };
  let sessionModel: { updateOne: jest.Mock };
  let service: CallCopilotService;

  beforeEach(() => {
    http = { post: jest.fn((_url: string, body: never) => translatedReply(body)) };
    sessionModel = { updateOne: jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) })) };
    service = new CallCopilotService(sessionModel as never, http as never, { sign: () => 'token' } as never, { get: () => undefined } as never, {} as never, {} as never);
  });

  it('English is the complete report, built locally — no AI call', async () => {
    const n = await service.getCoachNarration(makeSession() as never, 'en');
    expect(http.post).not.toHaveBeenCalled();
    expect(n.languageCode).toBe('en');
    expect(n.sections.map((s) => s.id)).toEqual(['overview', 'strengths', 'improvements', 'skills', 'concerns', 'coaching', 'next_steps']);
    expect(n.parts.length).toBeGreaterThanOrEqual(n.sections.length);
    expect(n.voiceScript).toContain('3.4 out of 10');
    expect(n.voiceScript).toContain('Acme Prints');
  });

  it('Tamil sends every English section to be rewritten, returns all of them, and caches them for this report', async () => {
    const session = makeSession();
    const n = await service.getCoachNarration(session as never, 'ta');
    const [url, body, options] = http.post.mock.calls[0];
    expect(url).toMatch(/\/call-copilot\/voice-script$/);
    expect(body.languageCode).toBe('ta');
    expect(body.sections.map((s: { id: string }) => s.id)).toEqual(n.sections.map((s) => s.id));
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(options.timeout).toBeGreaterThan(60_000);
    expect(n.sections.every((s) => s.text.startsWith('[ta] '))).toBe(true);
    expect(n.parts.every((p) => p.text.length <= MAX_SPOKEN_PART)).toBe(true);
    // Cached atomically, only while the report is still the one it was written from.
    const [filter, pipeline] = sessionModel.updateOne.mock.calls[0];
    expect(filter.coachingGeneratedAt).toEqual(session.coachingGeneratedAt);
    const entry = pipeline[0].$set.voiceScripts.$concatArrays[1][0];
    expect(entry).toMatchObject({ languageCode: 'ta', narrationKey: n.narrationKey });
  });

  it('a cached translation of this report is reused; Hindi never reuses Tamil', async () => {
    const english = buildCoachNarration(report(CALL_A));
    const key = narrationKey(english);
    const tamil = english.map((s) => ({ ...s, text: `[ta] ${s.text}` }));
    const session = makeSession({ overallScore: 3.4, voiceScripts: [{ languageCode: 'ta', narrationKey: key, sections: tamil, script: 'x' }] });

    const ta = await service.getCoachNarration(session as never, 'ta');
    expect(http.post).not.toHaveBeenCalled();
    expect(ta.sections[0].text.startsWith('[ta] ')).toBe(true);

    const hi = await service.getCoachNarration(session as never, 'hi');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(hi.sections.every((s) => s.text.startsWith('[hi] '))).toBe(true);
  });

  it('a translation of an older report, or the earlier short script, is never reused', async () => {
    const stale = makeSession({
      voiceScripts: [
        { languageCode: 'ta', script: 'பழைய சுருக்கம்' }, // the earlier short script: no key
        { languageCode: 'ta', narrationKey: 'an-older-report', sections: [{ id: 'overview', title: 'x', text: 'பழைய' }], script: 'பழைய' },
      ],
    });
    const n = await service.getCoachNarration(stale as never, 'ta');
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(n.voiceScript).not.toContain('பழைய');
  });

  it.each(VOICE_LANGUAGE_CODES.filter((c) => c !== 'en'))('%s: the whole report is prepared in that language', async (code) => {
    const n = await service.getCoachNarration(makeSession() as never, code);
    expect(http.post.mock.calls[0][1].languageCode).toBe(code);
    expect(n.languageCode).toBe(code);
    expect(n.sections).toHaveLength(7);
    expect(n.sections.every((s) => s.text.startsWith(`[${code}] `))).toBe(true);
  });

  it('a translation missing a section is refused, not spoken as the whole report', async () => {
    http.post.mockReturnValueOnce(of({ data: { sections: [{ id: 'overview', text: 'மதிப்பெண் 34' }] } }));
    await expect(service.getCoachNarration(makeSession() as never, 'ta')).rejects.toBeInstanceOf(BadGatewayException);
    expect(sessionModel.updateOne).not.toHaveBeenCalled();
  });

  it('failures are worded for the person: python-agent’s reason, down, or too slow', async () => {
    http.post.mockReturnValueOnce(throwError(() => axiosError(502, 'The AI Coach report couldn’t be prepared in this language. Please try again.')));
    await expect(service.getCoachNarration(makeSession() as never, 'ta')).rejects.toThrow('couldn’t be prepared in this language');

    http.post.mockReturnValueOnce(throwError(() => axiosError(undefined, undefined, 'ECONNREFUSED')));
    await expect(service.getCoachNarration(makeSession() as never, 'ta')).rejects.toBeInstanceOf(ServiceUnavailableException);

    http.post.mockReturnValueOnce(throwError(() => axiosError(undefined, undefined, 'ECONNABORTED')));
    await expect(service.getCoachNarration(makeSession() as never, 'ta')).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('a call with no coaching report has nothing to narrate', async () => {
    await expect(service.getCoachNarration(makeSession({ overallScore: undefined }) as never, 'en')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('who can hear a call’s narration', () => {
  const user = { sub: 'user-1', organizationId: 'org-1' } as never;
  let calls: { getSession: jest.Mock; getCoachNarration: jest.Mock };
  let controller: CallCopilotController;

  beforeEach(() => {
    calls = { getSession: jest.fn(async () => null), getCoachNarration: jest.fn(async () => ({ sections: [] })) };
    controller = new CallCopilotController(calls as never, {} as never, {} as never, {} as never, {} as never);
  });

  it('looks the call up only within the caller’s own organization and their own calls', async () => {
    await expect(controller.voiceScript(user, '64b000000000000000000001', { languageCode: 'ta' })).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.getSession).toHaveBeenCalledWith('org-1', 'user-1', '64b000000000000000000001');
    expect(calls.getCoachNarration).not.toHaveBeenCalled();
  });

  it('a malformed call id is "not found" without a database query', async () => {
    await expect(controller.voiceScript(user, 'not-an-id', { languageCode: 'ta' })).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.getSession).not.toHaveBeenCalled();
  });

  it('the caller’s own call is narrated in the language asked for', async () => {
    const session = makeSession();
    calls.getSession.mockResolvedValueOnce(session);
    await controller.voiceScript(user, '64b000000000000000000001', { languageCode: 'hi' });
    expect(calls.getCoachNarration).toHaveBeenCalledWith(session, 'hi');
  });

  it('only the eleven voice languages are accepted', async () => {
    for (const code of VOICE_LANGUAGE_CODES) {
      expect(await validate(plainToInstance(VoiceScriptDto, { languageCode: code }))).toHaveLength(0);
    }
    for (const bad of ['fr', 'xx', '', 'ta-IN']) {
      expect((await validate(plainToInstance(VoiceScriptDto, { languageCode: bad }))).length).toBeGreaterThan(0);
    }
  });
});
