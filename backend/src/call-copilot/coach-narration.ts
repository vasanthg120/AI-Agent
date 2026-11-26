import { createHash } from 'crypto';

// The AI Coach's spoken narration: the WHOLE report read out section by section
// (overall result, what went well, what to improve, every skill, serious
// concerns and missed opportunities, coaching, next steps), built in code from
// the report saved on this call — never from a template of coaching text and
// never from another call. English is spoken exactly as built here; any other
// language is this English rewritten natively by python-agent
// (/call-copilot/voice-script), section for section, so nothing is dropped.

/** Bumped whenever what the narration says changes, so cached translations of the old wording retire. */
export const NARRATION_VERSION = 3;

/** Under /voice/speak's 2,500-character limit, and short enough for the first words to come quickly. */
export const MAX_SPOKEN_PART = 900;

export type NarrationSectionId = 'overview' | 'strengths' | 'improvements' | 'skills' | 'concerns' | 'coaching' | 'next_steps';

export interface NarrationSection {
  id: NarrationSectionId;
  title: string;
  text: string;
}

/** One request to the voice: a section, or a sentence-safe piece of a long one. */
export interface NarrationPart {
  sectionId: NarrationSectionId;
  title: string;
  text: string;
}

const TITLES: Record<NarrationSectionId, string> = {
  overview: 'Overall performance',
  strengths: 'What you did well',
  improvements: 'What needs improvement',
  skills: 'Skill breakdown',
  concerns: 'Serious concerns and missed opportunities',
  coaching: 'Improvement recommendations',
  next_steps: 'Next steps',
};

// The earlier AI Coach's six skills and Call Intelligence's nine, for reports that carry only a key.
const CATEGORY_LABEL: Record<string, string> = {
  opening_rapport: 'Opening and rapport',
  discovery_listening: 'Discovery and listening',
  value_communication: 'Value communication',
  objection_handling: 'Objection handling',
  engagement_confidence: 'Engagement and confidence',
  closing_followup: 'Closing and follow-up',
  discovery: 'Requirement understanding and discovery',
  listening: 'Active listening and engagement',
  product_knowledge: 'Product and service knowledge',
  communication: 'Communication and clarity',
  value_proposition: 'Persuasion and value proposition',
  trust_building: 'Customer relationship and trust building',
  opportunity: 'Opportunity identification and buying signals',
  closure: 'Call closure and next steps',
};

const OUTCOME_LABEL: Record<string, string> = {
  sale_confirmed: 'the sale was confirmed',
  strong_progress: 'strong progress was made',
  next_step_agreed: 'a next step was agreed',
  information_only: 'information was exchanged, nothing more',
  no_progress: 'there was no progress',
  lost: 'the deal was lost',
  cut_short: 'the call was cut short',
  not_a_sales_call: 'this was not a sales call',
  unclear: 'the outcome is unclear',
};

const MISSED_LABEL: Record<string, string> = {
  unanswered_question: 'A customer question was left unanswered',
  missed_buying_signal: 'A buying signal was missed',
  unhandled_objection: 'An objection was not handled',
  missing_follow_up: 'No follow-up was set',
  value_not_explained: 'The value was not explained',
  no_meaningful_outcome: 'The call ended without a real outcome',
};

// ---- the report as saved on the call (loosely typed: older reports miss parts) ----

interface Evidence {
  quote?: string;
  at?: number | null;
  speaker?: string;
}

interface Evaluation {
  version?: number;
  assessable?: boolean;
  notAssessableReason?: string | null;
  score?: number | null;
  bandLabel?: string;
  coverage?: number;
  lowCoverage?: boolean;
  categories?: { key?: string; label?: string; score?: number | null; rationale?: string; notAssessableReason?: string }[];
  understanding?: { speakers?: { label?: string; role?: string }[] } | null;
  analysis?: {
    customerQuestions?: { question?: string; answered?: string; at?: number | null }[];
    objections?: { objection?: string; handling?: string; how?: string; at?: number | null }[];
    commitments?: { by?: string; text?: string; realistic?: boolean; at?: number | null }[];
    customerEngagement?: { level?: string; basis?: string };
    customerSentiment?: { start?: string; end?: string; basis?: string };
  } | null;
  challenge?: {
    missedOpportunities?: { kind?: string; text?: string; betterApproach?: string; evidence?: Evidence | null; at?: number | null }[];
    seriousConcerns?: { text?: string; evidence?: Evidence | null }[];
    expertWouldHaveDone?: string[];
  } | null;
  conclusion?: {
    outcome?: { result?: string; explanation?: string; performanceVsOutcome?: string } | null;
    verdict?: string;
    summaryForAgent?: string;
    strengths?: { text?: string; evidence?: Evidence | null }[];
    weaknesses?: { text?: string; severity?: string; impact?: string; evidence?: Evidence | null }[];
    coaching?: { change?: string; how?: string; example?: string }[];
    nextActions?: { text?: string; owner?: string; priority?: string; basis?: string }[];
  } | null;
  qa?: { adjustments?: { category?: string | null; to?: number | null; reason?: string }[] } | null;
}

export interface CoachReportSource {
  overallScore?: number | null;
  categoryScores?: { category?: string; score?: number; rationale?: string }[];
  whatWentWell?: string[];
  whatToImprove?: string[];
  whatWouldHaveDoneDifferently?: string[];
  nextCallFocus?: string[];
  keyMoments?: { momentType?: string; text?: string; recommendation?: string; occurredAt?: Date | string | null }[];
  coachingSummary?: string | null;
  evaluation?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

// ---- small speech helpers ----

/** One line of plain speech: no markdown or list marks, ends like a sentence. */
export function sentence(text: string | null | undefined): string {
  const clean = (text ?? '')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return /[.!?।॥…"”’)]$/.test(clean) ? clean : `${clean}.`;
}

/** "1 minute 42 seconds" — a time into the call as it is said, not "01:42". */
export function spokenTime(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sec = `${s} second${s === 1 ? '' : 's'}`;
  if (m === 0) return sec;
  const min = `${m} minute${m === 1 ? '' : 's'}`;
  return s === 0 ? min : `${min} ${sec}`;
}

/** A quote as said aloud, ending as a sentence without doubling a question or full stop. */
function quoted(text: string): string {
  const q = text.replace(/\s+/g, ' ').trim();
  return /[.!?।॥…]$/.test(q) ? `“${q}”` : `“${q}”.`;
}

/** A skill's name as it is said: "Product / Service Knowledge" → "Product and Service Knowledge". */
function spokenLabel(label: string): string {
  return label.replace(/\s*&\s*/g, ' and ').replace(/\s*\/\s*/g, ' and ').replace(/\s+/g, ' ').trim();
}

/** A review's 0–100 as the app shows it everywhere: out of 10, one decimal at most ("3.4", "7"). */
export function outOf10(score100: number): string {
  return String(Math.round(score100) / 10);
}

function nonEmpty<T>(items: T[] | null | undefined): T[] {
  return Array.isArray(items) ? items.filter(Boolean) : [];
}

function strings(items: string[] | null | undefined): string[] {
  return nonEmpty(items)
    .map((s) => sentence(s))
    .filter(Boolean);
}

function ordinal(n: number): string {
  return ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'][n] ?? `Number ${n + 1}`;
}

function paragraph(parts: (string | null | undefined | false)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Call Intelligence (evaluation version 2+) ----

function speakerName(evaluation: Evaluation): (label: string | undefined) => string {
  const roles = new Map(nonEmpty(evaluation.understanding?.speakers).map((s) => [s.label, s.role]));
  return (label) => {
    const role = label ? roles.get(label) : undefined;
    if (role === 'agent') return 'you said';
    if (role === 'customer') return 'the customer said';
    return 'someone said';
  };
}

function quoteLine(evidence: Evidence | null | undefined, said: (label: string | undefined) => string): string {
  const quote = evidence?.quote?.replace(/\s+/g, ' ').trim();
  if (!quote) return '';
  const time = spokenTime(evidence?.at);
  return `${time ? `At ${time} into the call, ` : 'In the call, '}${said(evidence?.speaker)}: ${quoted(quote)}`;
}

function evaluationSections(e: Evaluation): NarrationSection[] {
  const conclusion = e.conclusion ?? {};
  const challenge = e.challenge ?? {};
  const analysis = e.analysis ?? null;
  const said = speakerName(e);
  const sections: NarrationSection[] = [];
  const add = (id: NarrationSectionId, text: string) => {
    if (text.trim()) sections.push({ id, title: TITLES[id], text: text.trim() });
  };

  // A. Overall performance.
  if (!e.assessable || e.score === null || e.score === undefined) {
    add(
      'overview',
      paragraph([
        'Here is your AI Coach review of this call.',
        'This call could not be scored.',
        sentence(e.notAssessableReason) || 'There was not enough sales conversation to judge fairly.',
      ]),
    );
    return sections;
  }
  const outcome = conclusion.outcome;
  const engagement = analysis?.customerEngagement;
  const sentiment = analysis?.customerSentiment;
  add(
    'overview',
    paragraph([
      'Here is your AI Coach review of this call.',
      `You scored ${outOf10(e.score)} out of 10, which puts this call in the ${e.bandLabel ?? 'unrated'} band.`,
      sentence(conclusion.verdict),
      outcome?.result && `As for the business outcome, ${OUTCOME_LABEL[outcome.result] ?? 'the outcome is unclear'}.`,
      sentence(outcome?.explanation),
      sentence(outcome?.performanceVsOutcome),
      engagement?.level && engagement.level !== 'unclear' && `Customer engagement was ${engagement.level}. ${sentence(engagement.basis)}`,
      sentiment?.start && sentiment?.end && `The customer's mood went from ${sentiment.start} to ${sentiment.end}.`,
      e.lowCoverage &&
        `Only ${e.coverage ?? 0} percent of the scorecard could be judged on this call, so read the score with caution.`,
    ]),
  );

  // B. What you did well — only what the evaluation backed with a quote.
  const strengths = nonEmpty(conclusion.strengths).filter((s) => s.text);
  add(
    'strengths',
    strengths.length === 0
      ? 'What you did well: nothing in this call stood out enough to count as a clear strength.'
      : paragraph([
          `What you did well. There ${strengths.length === 1 ? 'is one strength' : `are ${strengths.length} strengths`}.`,
          ...strengths.map((s, i) => `${ordinal(i)}: ${sentence(s.text)}`),
        ]),
  );

  // C. What needs improvement: weaknesses (worst first), objections not handled well, unanswered questions.
  const rank: Record<string, number> = { critical: 0, major: 1, minor: 2 };
  const weaknesses = nonEmpty(conclusion.weaknesses)
    .filter((w) => w.text)
    .sort((a, b) => (rank[a.severity ?? ''] ?? 3) - (rank[b.severity ?? ''] ?? 3));
  const objections = nonEmpty(analysis?.objections).filter((o) => o.objection && o.handling !== 'well');
  const unanswered = nonEmpty(analysis?.customerQuestions).filter((q) => q.question && q.answered !== 'yes');
  if (weaknesses.length + objections.length + unanswered.length === 0) {
    add('improvements', 'What needs improvement: the review found no weaknesses worth flagging on this call.');
  } else {
    add(
      'improvements',
      paragraph([
        'What needs improvement.',
        ...weaknesses.map((w) =>
          paragraph([
            `${w.severity ? `A ${w.severity} issue` : 'An issue'}: ${sentence(w.text)}`,
            w.impact && `The impact: ${sentence(w.impact)}`,
          ]),
        ),
        ...objections.map((o) => {
          const time = spokenTime(o.at);
          return paragraph([
            `${time ? `At ${time}, the` : 'The'} customer objected: “${o.objection!.trim()}”, and it was ${o.handling === 'partly' ? 'only partly handled' : 'not handled'}.`,
            sentence(o.how),
          ]);
        }),
        ...unanswered.map((q) => {
          const time = spokenTime(q.at);
          return `${time ? `At ${time}, the` : 'The'} customer asked: “${q.question!.trim()}”, and it was ${q.answered === 'partly' ? 'only partly answered' : 'not answered'}.`;
        }),
      ]),
    );
  }

  // D. Skill breakdown — every skill the report holds, in its order, with the reason for its mark.
  const categories = nonEmpty(e.categories);
  const totalCaps = nonEmpty(e.qa?.adjustments).filter((a) => !a.category && a.to !== null && a.to !== undefined && a.reason);
  if (categories.length > 0) {
    add(
      'skills',
      paragraph([
        `Now your skill breakdown, ${categories.length} skill${categories.length === 1 ? '' : 's'}, each scored out of 10.`,
        ...categories.map((c) => {
          const label = spokenLabel(c.label || CATEGORY_LABEL[c.key ?? ''] || c.key || 'A skill');
          return c.score === null || c.score === undefined
            ? `${label}: not assessable. ${sentence(c.notAssessableReason) || 'The call gave no fair chance to judge it.'}`
            : `${label}: ${c.score} out of 10. ${sentence(c.rationale)}`;
        }),
        ...totalCaps.map((a) => `Your overall score was held at ${outOf10(a.to!)} because ${sentence(a.reason).replace(/^./, (ch) => ch.toLowerCase())}`),
      ]),
    );
  }

  // E. Serious concerns and missed opportunities, with the words and the time they happened.
  const concerns = nonEmpty(challenge.seriousConcerns).filter((c) => c.text);
  const missed = nonEmpty(challenge.missedOpportunities).filter((m) => m.text);
  if (concerns.length + missed.length > 0) {
    add(
      'concerns',
      paragraph([
        concerns.length > 0 &&
          `There ${concerns.length === 1 ? 'is one serious concern' : `are ${concerns.length} serious concerns`}.`,
        ...concerns.map((c) => paragraph([sentence(c.text), quoteLine(c.evidence, said)])),
        missed.length > 0 &&
          `${concerns.length > 0 ? 'And there' : 'There'} ${missed.length === 1 ? 'was one missed opportunity' : `were ${missed.length} missed opportunities`}.`,
        ...missed.map((m) => {
          const time = spokenTime(m.at);
          return paragraph([
            `${MISSED_LABEL[m.kind ?? ''] ?? 'An opportunity was missed'}${time ? ` at ${time}` : ''}: ${sentence(m.text)}`,
            quoteLine(m.evidence, said),
            m.betterApproach && `Better: ${sentence(m.betterApproach)}`,
          ]);
        }),
      ]),
    );
  }

  // F. Improvement recommendations: what to change, how, and words to try.
  const coaching = nonEmpty(conclusion.coaching).filter((c) => c.change || c.how);
  const expert = strings(challenge.expertWouldHaveDone);
  if (coaching.length > 0) {
    add(
      'coaching',
      paragraph([
        'Here is what to do differently on your next call.',
        ...coaching.map((c, i) =>
          paragraph([`${ordinal(i)}: ${sentence(c.change)}`, sentence(c.how), c.example?.trim() && `You could say: ${quoted(c.example)}`]),
        ),
      ]),
    );
  } else if (expert.length > 0) {
    add('coaching', paragraph(['Here is what an expert would have done on this call.', ...expert]));
  }

  // G. Next steps: the recommended actions and what was committed to on the call.
  const actions = nonEmpty(conclusion.nextActions).filter((a) => a.text);
  const commitments = nonEmpty(analysis?.commitments).filter((c) => c.text);
  const owner = (who: string | undefined) => (who === 'customer' ? 'For the customer' : who === 'manager' ? 'For your manager' : 'For you');
  add(
    'next_steps',
    paragraph([
      actions.length === 0 && commitments.length === 0 && 'Next steps: the report lists no next actions for this call.',
      actions.length > 0 && 'Next steps.',
      ...actions.map((a) =>
        paragraph([`${owner(a.owner)}${a.priority ? `, ${a.priority} priority` : ''}: ${sentence(a.text)}`, sentence(a.basis)]),
      ),
      commitments.length > 0 && 'Commitments made on the call.',
      ...commitments.map((c) => {
        const time = spokenTime(c.at);
        return paragraph([
          `${c.by === 'customer' ? 'The customer' : 'You'} committed${time ? ` at ${time}` : ''}: ${sentence(c.text)}`,
          c.realistic === false && 'That commitment may not be realistic.',
        ]);
      }),
      'That is the complete AI Coach review of this call.',
    ]),
  );
  return sections;
}

// ---- the earlier AI Coach report (before Call Intelligence) ----

function legacySections(r: CoachReportSource): NarrationSection[] {
  const sections: NarrationSection[] = [];
  const add = (id: NarrationSectionId, text: string) => {
    if (text.trim()) sections.push({ id, title: TITLES[id], text: text.trim() });
  };
  const scores = nonEmpty(r.categoryScores);
  const overall = typeof r.overallScore === 'number' ? r.overallScore : 0;
  if (scores.length > 0 && scores.every((c) => !c.score)) {
    add('overview', 'Here is your AI Coach review of this call. There was no sales conversation to score in this call.');
    return sections;
  }
  const band = overall >= 8.5 ? 'Excellent' : overall >= 7 ? 'Strong' : overall >= 4 ? 'Fair' : 'Needs work';
  add(
    'overview',
    paragraph([
      'Here is your AI Coach review of this call.',
      `You scored ${overall} out of 10, which is rated ${band}.`,
      sentence(r.coachingSummary),
    ]),
  );
  const well = strings(r.whatWentWell);
  add('strengths', well.length ? paragraph(['What you did well.', ...well]) : 'What you did well: nothing stood out enough to count as a clear strength.');
  const improve = strings(r.whatToImprove);
  if (improve.length) add('improvements', paragraph(['What needs improvement.', ...improve]));
  if (scores.length) {
    add(
      'skills',
      paragraph([
        'Now your skill breakdown, each scored out of 10.',
        ...scores.map((c) => `${CATEGORY_LABEL[c.category ?? ''] ?? c.category ?? 'A skill'}: ${c.score ?? 0} out of 10. ${sentence(c.rationale)}`),
      ]),
    );
  }
  const start = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
  const moments = nonEmpty(r.keyMoments).filter((m) => (m.momentType === 'missed_opportunity' || m.momentType === 'risk_signal') && m.text);
  if (moments.length) {
    add(
      'concerns',
      paragraph([
        'Concerns and missed opportunities.',
        ...moments.map((m) => {
          const at = m.occurredAt && Number.isFinite(start) ? (new Date(m.occurredAt).getTime() - start) / 1000 : null;
          const time = spokenTime(at);
          return paragraph([
            `${m.momentType === 'risk_signal' ? 'A risk' : 'A missed opportunity'}${time ? ` at ${time}` : ''}: ${sentence(m.text)}`,
            m.recommendation && `Better: ${sentence(m.recommendation)}`,
          ]);
        }),
      ]),
    );
  }
  const differently = strings(r.whatWouldHaveDoneDifferently);
  if (differently.length) add('coaching', paragraph(['Here is what I would have done differently.', ...differently]));
  const focus = strings(r.nextCallFocus);
  add(
    'next_steps',
    paragraph([focus.length ? 'For your next call, focus on this.' : '', ...focus, 'That is the complete AI Coach review of this call.']),
  );
  return sections;
}

/** The complete English narration of the report saved on this call, in reading order. */
export function buildCoachNarration(report: CoachReportSource): NarrationSection[] {
  const evaluation = report.evaluation as Evaluation | null | undefined;
  if (evaluation && typeof evaluation === 'object' && (evaluation.version ?? 0) >= 2) return evaluationSections(evaluation);
  return legacySections(report);
}

/** Identifies one narration's wording: a different report, or a new narration version, gets a new key. */
export function narrationKey(sections: NarrationSection[]): string {
  return createHash('sha256')
    .update(JSON.stringify([NARRATION_VERSION, sections.map((s) => [s.id, s.text])]))
    .digest('hex')
    .slice(0, 24);
}

/**
 * A section split for the voice without ever cutting a sentence: pieces end at a
 * full stop, question or exclamation mark, or a danda — a decimal point ("7.5")
 * is not a sentence end. Only a single sentence longer than the limit is split,
 * at a comma or space.
 */
export function splitForSpeech(text: string, max = MAX_SPOKEN_PART): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^]*?(?:[.!?।॥]+["'”’)\]]*(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const parts: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current = `${current} ${piece}`;
    else {
      parts.push(current);
      current = piece;
    }
  };
  for (const s of sentences) {
    if (s.length <= max) {
      push(s);
      continue;
    }
    // One very long sentence: break at the last comma (else space) before the limit.
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('، '));
      const cut = comma > max / 2 ? comma + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : max;
      push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) push(rest);
  }
  if (current) parts.push(current);
  return parts;
}

/** The sections as the requests the voice is sent, in order. */
export function narrationParts(sections: NarrationSection[], max = MAX_SPOKEN_PART): NarrationPart[] {
  return sections.flatMap((s) => splitForSpeech(s.text, max).map((text) => ({ sectionId: s.id, title: s.title, text })));
}
