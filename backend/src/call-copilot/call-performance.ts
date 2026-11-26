// Call performance analytics: what the AI Coach's reviews say about each person
// and the team over a period. Worked out only from reports already saved on the
// calls (Call Intelligence, python-agent app/agent/call_intelligence.py): no AI
// call, no invented figure. Scores are shown out of 10 (the review's 0–100
// divided by 10, as every list already does).
//
// Fair by design: nobody is ranked, called a high performer or flagged for
// coaching on fewer than MIN_SCORED_TO_RANK reviewed calls, and "improving" or
// "declining" needs reviewed calls in both this period and the one before.

export const MIN_SCORED_TO_RANK = 3;
export const MIN_SCORED_FOR_TREND = 2;
const HIGH = 7;
const COACHING = 5;
const TREND_STEP = 0.5;
const LIST_SIZE = 6;

const SUCCESS = new Set(['sale_confirmed', 'strong_progress', 'next_step_agreed']);

export const CATEGORY_LABEL: Record<string, string> = {
  discovery: 'Requirement understanding & discovery',
  listening: 'Active listening & engagement',
  product_knowledge: 'Product / service knowledge',
  communication: 'Communication & clarity',
  objection_handling: 'Objection handling',
  value_proposition: 'Persuasion & value proposition',
  trust_building: 'Relationship & trust building',
  opportunity: 'Buying signals & opportunity',
  closure: 'Call closure & next steps',
};

// What to practise when a skill is someone's weakest across their calls.
export const TRAINING: Record<string, string> = {
  discovery: 'Discovery questioning: ask about need, quantity, date and budget before offering anything',
  listening: 'Active listening: let the customer finish, then summarise what they said back to them',
  product_knowledge: 'Product knowledge: options, pricing, MOQ and lead times, ready to answer on the call',
  communication: 'Clear, concise explanations: one point at a time, check it landed',
  objection_handling: 'Objection handling: acknowledge, ask what is behind it, answer with an option',
  value_proposition: 'Value selling: tie each feature to what this customer said they need',
  trust_building: 'Building rapport and trust: use their name, follow through on what you promise',
  opportunity: 'Spotting buying signals and moving the customer to the next step',
  closure: 'Closing every call with a dated next step both sides agree on',
};

export const MISSED_LABEL: Record<string, string> = {
  unanswered_question: 'Customer questions left unanswered',
  missed_buying_signal: 'Buying signals missed',
  unhandled_objection: 'Objections not handled',
  missing_follow_up: 'No follow-up set',
  value_not_explained: 'Value not explained',
  no_meaningful_outcome: 'Calls ending with no real outcome',
  other: 'Other missed opportunities',
};

/** A call as the analytics read it (a projection of call_sessions). */
export interface PerformanceCall {
  _id: { toString(): string } | string;
  organizationId: string;
  userId: string;
  createdAt: Date | string;
  source?: string;
  originalFilename?: string;
  headline?: string;
  overallScore?: number | null;
  sentiment?: string | null;
  evaluation?: {
    version?: number;
    assessable?: boolean;
    bandLabel?: string;
    categories?: { key?: string; label?: string; score?: number | null }[];
    conclusion?: {
      outcome?: { result?: string } | null;
      strengths?: { text?: string }[];
      nextActions?: unknown[];
    } | null;
    analysis?: {
      customerSentiment?: { end?: string } | null;
      customerQuestions?: { answered?: string }[];
      objections?: { handling?: string }[];
    } | null;
    challenge?: { seriousConcerns?: unknown[]; missedOpportunities?: { kind?: string }[] } | null;
  } | null;
}

export type Direction = 'improving' | 'declining' | 'steady';
export type Standing = 'high' | 'coaching' | 'steady' | 'too_few';

export interface CallListItem {
  id: string;
  organizationId: string;
  ownerId: string;
  ownerName: string;
  businessName?: string;
  headline: string;
  createdAt: string;
  kind: 'live' | 'upload' | 'phone';
  score: number | null;
  band: string | null;
  reasons: string[];
  mine: boolean;
}

export interface CategoryAverage {
  key: string;
  label: string;
  average: number;
  calls: number;
}

export interface PersonPerformance {
  userId: string;
  organizationId: string;
  name: string;
  businessName?: string;
  // The viewer themselves; and whether they are in the viewer's own business (Employee Activity is per business).
  isViewer: boolean;
  sameBusiness: boolean;
  calls: number;
  analysed: number;
  averageScore: number | null;
  previousAverage: number | null;
  change: number | null;
  direction: Direction | null;
  standing: Standing;
  rank: number | null;
  successRate: number | null;
  satisfaction: number | null;
  communication: number | null;
  listening: number | null;
  categories: CategoryAverage[];
  strengths: CategoryAverage[];
  focus: (CategoryAverage & { training: string })[];
  recurring: { kind: string; label: string; count: number }[];
  recognition: { sessionId: string; score: number; text: string; createdAt: string }[];
  trend: TrendPoint[];
}

export interface TrendPoint {
  start: string;
  label: string;
  calls: number;
  averageScore: number | null;
}

export interface CallPerformance {
  range: { from: string; to: string; previousFrom: string; previousTo: string; bucket: 'day' | 'week' | 'month' };
  overview: {
    calls: number;
    analysed: number;
    averageScore: number | null;
    previousAverage: number | null;
    change: number | null;
    successful: number;
    successRate: number | null;
    highPerformers: number;
    needCoaching: number;
    people: number;
    sentiment: Record<'positive' | 'neutral' | 'negative' | 'mixed' | 'unclear', number>;
    trend: TrendPoint[];
  };
  categories: CategoryAverage[];
  people: PersonPerformance[];
  lists: Record<'attention' | 'top' | 'negative' | 'unresolved' | 'noFollowUp' | 'recent', CallListItem[]>;
  limits: { minCallsToRank: number; capped: boolean };
}

export interface PerformanceOptions {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  // Minutes east of UTC of the viewer, so days and weeks are theirs.
  utcOffsetMinutes: number;
  names: Map<string, string>;
  businessNames: Map<string, string>;
  viewer: { organizationId: string; userId: string };
  capped?: boolean;
}

// ---- helpers ----

const round1 = (n: number) => Math.round(n * 10) / 10;
const avg = (values: number[]) => (values.length ? round1(values.reduce((s, v) => s + v, 0) / values.length) : null);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const idOf = (c: PerformanceCall) => (typeof c._id === 'string' ? c._id : c._id.toString());
const ownerKey = (c: { organizationId: string; userId: string }) => `${c.organizationId}|${c.userId}`;

/** Out of 10, or null when the call has no review (0 = too little conversation to judge). */
export function scoreOf(c: Pick<PerformanceCall, 'overallScore'>): number | null {
  return typeof c.overallScore === 'number' && c.overallScore > 0 ? round1(c.overallScore) : null;
}

export function kindOf(c: Pick<PerformanceCall, 'source' | 'originalFilename'>): 'live' | 'upload' | 'phone' {
  if (c.source !== 'upload') return 'live';
  return /^(plivo|twilio)-/.test(c.originalFilename ?? '') ? 'phone' : 'upload';
}

function endSentiment(c: PerformanceCall): keyof CallPerformance['overview']['sentiment'] | null {
  const end = c.evaluation?.analysis?.customerSentiment?.end ?? c.sentiment ?? null;
  if (!end) return null;
  return (['positive', 'neutral', 'negative', 'mixed'] as const).includes(end as never) ? (end as 'positive') : 'unclear';
}

function categoryScores(c: PerformanceCall): { key: string; label: string; score: number }[] {
  if ((c.evaluation?.version ?? 0) < 2 || !c.evaluation?.assessable) return [];
  return (c.evaluation.categories ?? [])
    .filter((k) => k.key && typeof k.score === 'number')
    .map((k) => ({ key: k.key!, label: CATEGORY_LABEL[k.key!] ?? k.label ?? k.key!, score: k.score! }));
}

function categoryAverages(calls: PerformanceCall[]): CategoryAverage[] {
  const by = new Map<string, { label: string; scores: number[] }>();
  for (const c of calls) {
    for (const k of categoryScores(c)) {
      const entry = by.get(k.key) ?? { label: k.label, scores: [] };
      entry.scores.push(k.score);
      by.set(k.key, entry);
    }
  }
  // The scorecard's own order; anything unknown last.
  const order = Object.keys(CATEGORY_LABEL);
  const place = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return [...by.entries()]
    .map(([key, v]) => ({ key, label: v.label, average: avg(v.scores)!, calls: v.scores.length }))
    .sort((a, b) => place(a.key) - place(b.key));
}

/** The start of the bucket a moment falls in, in the viewer's own calendar. */
function bucketStart(at: Date, bucket: 'day' | 'week' | 'month', offsetMin: number): Date {
  const local = new Date(at.getTime() + offsetMin * 60_000);
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  let d = local.getUTCDate();
  if (bucket === 'month') d = 1;
  if (bucket === 'week') {
    const dow = (local.getUTCDay() + 6) % 7; // Monday first
    const monday = new Date(Date.UTC(y, m, d - dow));
    y = monday.getUTCFullYear();
    m = monday.getUTCMonth();
    d = monday.getUTCDate();
  }
  return new Date(Date.UTC(y, m, d) - offsetMin * 60_000);
}

function nextBucket(start: Date, bucket: 'day' | 'week' | 'month', offsetMin: number): Date {
  const local = new Date(start.getTime() + offsetMin * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const next = bucket === 'month' ? Date.UTC(y, m + 1, 1) : Date.UTC(y, m, d + (bucket === 'week' ? 7 : 1));
  return new Date(next - offsetMin * 60_000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(start: Date, bucket: 'day' | 'week' | 'month', offsetMin: number): string {
  const local = new Date(start.getTime() + offsetMin * 60_000);
  const day = `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`;
  if (bucket === 'month') return `${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
  return bucket === 'week' ? `Wk of ${day}` : day;
}

/** Days for a fortnight, weeks up to about four months, months beyond: enough points to show a trend, few enough to read. */
export function bucketFor(from: Date, to: Date): 'day' | 'week' | 'month' {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return days <= 15 ? 'day' : days <= 125 ? 'week' : 'month';
}

function trend(calls: PerformanceCall[], from: Date, to: Date, bucket: 'day' | 'week' | 'month', offsetMin: number): TrendPoint[] {
  const points: TrendPoint[] = [];
  const index = new Map<number, { calls: number; scores: number[] }>();
  for (let s = bucketStart(from, bucket, offsetMin); s.getTime() <= to.getTime() && points.length < 400; s = nextBucket(s, bucket, offsetMin)) {
    points.push({ start: s.toISOString(), label: bucketLabel(s, bucket, offsetMin), calls: 0, averageScore: null });
    index.set(s.getTime(), { calls: 0, scores: [] });
  }
  for (const c of calls) {
    const slot = index.get(bucketStart(new Date(c.createdAt), bucket, offsetMin).getTime());
    if (!slot) continue;
    slot.calls += 1;
    const s = scoreOf(c);
    if (s !== null) slot.scores.push(s);
  }
  return points.map((p) => {
    const slot = index.get(new Date(p.start).getTime())!;
    return { ...p, calls: slot.calls, averageScore: avg(slot.scores) };
  });
}

function direction(now: number | null, before: number | null, nowCount: number, beforeCount: number): Direction | null {
  if (now === null || before === null || nowCount < MIN_SCORED_FOR_TREND || beforeCount < MIN_SCORED_FOR_TREND) return null;
  const change = now - before;
  return change >= TREND_STEP ? 'improving' : change <= -TREND_STEP ? 'declining' : 'steady';
}

// ---- the analytics ----

export function buildCallPerformance(calls: PerformanceCall[], previous: PerformanceCall[], options: PerformanceOptions): CallPerformance {
  const { names, businessNames, viewer } = options;
  const bucket = bucketFor(options.from, options.to);
  const scored = calls.filter((c) => scoreOf(c) !== null);
  const previousScored = previous.filter((c) => scoreOf(c) !== null);
  const successful = scored.filter((c) => SUCCESS.has(c.evaluation?.conclusion?.outcome?.result ?? '')).length;
  const withOutcome = scored.filter((c) => c.evaluation?.conclusion?.outcome?.result).length;

  const sentiment = { positive: 0, neutral: 0, negative: 0, mixed: 0, unclear: 0 };
  for (const c of scored) {
    const s = endSentiment(c);
    if (s) sentiment[s] += 1;
  }

  const item = (c: PerformanceCall, reasons: string[]): CallListItem => ({
    id: idOf(c),
    organizationId: c.organizationId,
    ownerId: c.userId,
    ownerName: names.get(c.userId) ?? 'Former user',
    businessName: businessNames.get(c.organizationId),
    headline: c.headline?.trim() || 'Untitled call',
    createdAt: new Date(c.createdAt).toISOString(),
    kind: kindOf(c),
    score: scoreOf(c),
    band: c.evaluation?.bandLabel ?? null,
    reasons,
    mine: c.organizationId === viewer.organizationId && c.userId === viewer.userId,
  });

  // ---- each person ----
  const byPerson = new Map<string, PerformanceCall[]>();
  for (const c of calls) byPerson.set(ownerKey(c), [...(byPerson.get(ownerKey(c)) ?? []), c]);
  const previousByPerson = new Map<string, number[]>();
  for (const c of previousScored) previousByPerson.set(ownerKey(c), [...(previousByPerson.get(ownerKey(c)) ?? []), scoreOf(c)!]);

  const people: PersonPerformance[] = [...byPerson.entries()].map(([key, mine]) => {
    const [organizationId, userId] = key.split('|');
    const own = mine.filter((c) => scoreOf(c) !== null);
    const scores = own.map((c) => scoreOf(c)!);
    const before = previousByPerson.get(key) ?? [];
    const averageScore = avg(scores);
    const previousAverage = avg(before);
    const categories = categoryAverages(own);
    const ranked = [...categories].sort((a, b) => b.average - a.average);
    const outcomes = own.filter((c) => c.evaluation?.conclusion?.outcome?.result);
    const sentiments = own.map(endSentiment).filter((s): s is NonNullable<typeof s> => !!s && s !== 'unclear');
    const missed = new Map<string, number>();
    for (const c of own) for (const m of c.evaluation?.challenge?.missedOpportunities ?? []) missed.set(m.kind ?? 'other', (missed.get(m.kind ?? 'other') ?? 0) + 1);
    const enough = own.length >= MIN_SCORED_TO_RANK;
    const standing: Standing = !enough ? 'too_few' : averageScore! >= HIGH ? 'high' : averageScore! < COACHING ? 'coaching' : 'steady';
    return {
      userId,
      organizationId,
      name: names.get(userId) ?? 'Former user',
      businessName: businessNames.get(organizationId),
      isViewer: organizationId === viewer.organizationId && userId === viewer.userId,
      sameBusiness: organizationId === viewer.organizationId,
      calls: mine.length,
      analysed: own.length,
      averageScore,
      previousAverage,
      change: averageScore !== null && previousAverage !== null ? round1(averageScore - previousAverage) : null,
      direction: direction(averageScore, previousAverage, own.length, before.length),
      standing,
      rank: null,
      successRate: pct(outcomes.filter((c) => SUCCESS.has(c.evaluation!.conclusion!.outcome!.result!)).length, outcomes.length),
      satisfaction: pct(sentiments.filter((s) => s === 'positive').length, sentiments.length),
      communication: categories.find((k) => k.key === 'communication')?.average ?? null,
      listening: categories.find((k) => k.key === 'listening')?.average ?? null,
      categories,
      // A strength is a skill they do well (7+), not just their least-bad one.
      strengths: ranked.filter((k) => k.average >= HIGH).slice(0, 3),
      focus: ranked
        .filter((k) => k.average < HIGH)
        .reverse()
        .slice(0, 3)
        .map((k) => ({ ...k, training: TRAINING[k.key] ?? `Practise ${k.label.toLowerCase()}` })),
      // Happened on at least two of their calls: a habit, not a one-off.
      recurring: [...missed.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => ({ kind, label: MISSED_LABEL[kind] ?? MISSED_LABEL.other, count })),
      // Earned: a call scored 8+ with a strength the review backed with a quote.
      recognition: own
        .filter((c) => scoreOf(c)! >= 8 && c.evaluation?.conclusion?.strengths?.[0]?.text)
        .sort((a, b) => scoreOf(b)! - scoreOf(a)!)
        .slice(0, 5)
        .map((c) => ({ sessionId: idOf(c), score: scoreOf(c)!, text: c.evaluation!.conclusion!.strengths![0].text!, createdAt: new Date(c.createdAt).toISOString() })),
      trend: trend(mine, options.from, options.to, bucket, options.utcOffsetMinutes),
    };
  });
  // Ranked only among people with enough reviewed calls; ties share a place.
  const rankable = people.filter((p) => p.standing !== 'too_few').sort((a, b) => b.averageScore! - a.averageScore!);
  rankable.forEach((p, i) => {
    p.rank = i > 0 && rankable[i - 1].averageScore === p.averageScore ? rankable[i - 1].rank : i + 1;
  });
  people.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.averageScore ?? -1) - (a.averageScore ?? -1) || a.name.localeCompare(b.name));

  // ---- calls worth opening ----
  const newestFirst = (a: PerformanceCall, b: PerformanceCall) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  const attention = scored
    .map((c) => {
      const reasons: string[] = [];
      const concerns = c.evaluation?.challenge?.seriousConcerns?.length ?? 0;
      if (concerns) reasons.push(concerns === 1 ? 'Serious concern' : `${concerns} serious concerns`);
      if (scoreOf(c)! < COACHING) reasons.push(`Scored ${scoreOf(c)}/10`);
      return { c, reasons };
    })
    .filter((x) => x.reasons.length)
    .sort((a, b) => scoreOf(a.c)! - scoreOf(b.c)! || newestFirst(a.c, b.c))
    .slice(0, LIST_SIZE)
    .map((x) => item(x.c, x.reasons));
  const top = scored
    .filter((c) => scoreOf(c)! >= HIGH)
    .sort((a, b) => scoreOf(b)! - scoreOf(a)! || newestFirst(a, b))
    .slice(0, LIST_SIZE)
    .map((c) => item(c, c.evaluation?.conclusion?.strengths?.[0]?.text ? [c.evaluation.conclusion.strengths[0].text!] : []));
  const negative = scored
    .filter((c) => endSentiment(c) === 'negative')
    .sort(newestFirst)
    .slice(0, LIST_SIZE)
    .map((c) => item(c, ['Customer ended negative']));
  const unresolved = scored
    .map((c) => {
      const questions = (c.evaluation?.analysis?.customerQuestions ?? []).filter((q) => q.answered === 'no').length;
      const objections = (c.evaluation?.analysis?.objections ?? []).filter((o) => o.handling === 'not_handled').length;
      const reasons = [
        questions && `${questions} question${questions === 1 ? '' : 's'} unanswered`,
        objections && `${objections} objection${objections === 1 ? '' : 's'} not handled`,
      ].filter((r): r is string => !!r);
      return { c, reasons };
    })
    .filter((x) => x.reasons.length)
    .sort((a, b) => newestFirst(a.c, b.c))
    .slice(0, LIST_SIZE)
    .map((x) => item(x.c, x.reasons));
  const noFollowUp = scored
    .map((c) => {
      const missing = (c.evaluation?.challenge?.missedOpportunities ?? []).some((m) => m.kind === 'missing_follow_up');
      const closure = categoryScores(c).find((k) => k.key === 'closure')?.score;
      const reasons = [missing && 'No follow-up set', closure !== undefined && closure <= 4 && `Closing scored ${closure}/10`].filter((r): r is string => !!r);
      return { c, reasons };
    })
    .filter((x) => x.reasons.length)
    .sort((a, b) => newestFirst(a.c, b.c))
    .slice(0, LIST_SIZE)
    .map((x) => item(x.c, x.reasons));
  const recent = [...scored].sort(newestFirst).slice(0, LIST_SIZE).map((c) => item(c, []));

  const averageScore = avg(scored.map((c) => scoreOf(c)!));
  const previousAverage = avg(previousScored.map((c) => scoreOf(c)!));
  return {
    range: {
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      previousFrom: options.previousFrom.toISOString(),
      previousTo: options.previousTo.toISOString(),
      bucket,
    },
    overview: {
      calls: calls.length,
      analysed: scored.length,
      averageScore,
      previousAverage,
      change: averageScore !== null && previousAverage !== null && previousScored.length > 0 ? round1(averageScore - previousAverage) : null,
      successful,
      successRate: pct(successful, withOutcome),
      highPerformers: people.filter((p) => p.standing === 'high').length,
      needCoaching: people.filter((p) => p.standing === 'coaching').length,
      people: people.length,
      sentiment,
      trend: trend(calls, options.from, options.to, bucket, options.utcOffsetMinutes),
    },
    categories: categoryAverages(scored),
    people,
    lists: { attention, top, negative, unresolved, noFollowUp, recent },
    limits: { minCallsToRank: MIN_SCORED_TO_RANK, capped: !!options.capped },
  };
}
