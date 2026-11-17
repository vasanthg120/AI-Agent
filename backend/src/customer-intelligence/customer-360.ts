// Customer 360°: what HaiVE concludes about one customer from the records the
// customer directory already gathered for them (customer-directory.service.ts)
// plus their phone calls — relationship, health, call figures and the next
// best actions. Pure: no database, no AI. Every conclusion carries the reasons
// (and, for actions, the records) it rests on; missing information is said to
// be missing and never counted against the customer.

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- settings (per business, editable by its owner/admins) -------------------------

export const HEALTH_COMPONENTS = ['engagement', 'purchase', 'payment', 'responsiveness', 'sentiment', 'conversion', 'followUp'] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export interface IntelligenceSettings {
  /** No interaction for this long: a customer who had business with us is dormant. */
  dormantAfterDays: number;
  /** First seen this recently, with nothing bought yet: a new customer. */
  newCustomerDays: number;
  /** This many completed orders or more: a repeat customer. */
  repeatMinOrders: number;
  /** Lifetime revenue in the top this-many percent of the business's paying customers: high value. */
  highValueTopPercent: number;
  /** A customer email unanswered this long puts the relationship at risk. */
  unansweredRiskDays: number;
  /** How much each part counts in the health score (relative; they need not add up to 100). */
  weights: Record<HealthComponent, number>;
}

export const DEFAULT_SETTINGS: IntelligenceSettings = {
  dormantAfterDays: 90,
  newCustomerDays: 30,
  repeatMinOrders: 2,
  highValueTopPercent: 10,
  unansweredRiskDays: 3,
  weights: { engagement: 20, purchase: 20, payment: 15, responsiveness: 15, sentiment: 10, conversion: 10, followUp: 10 },
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Saved settings merged over the defaults, every value kept in a sensible range. */
export function resolveSettings(saved?: Partial<IntelligenceSettings> | null): IntelligenceSettings {
  const s = saved ?? {};
  const weights = { ...DEFAULT_SETTINGS.weights };
  for (const key of HEALTH_COMPONENTS) weights[key] = clampInt(s.weights?.[key], 0, 100, DEFAULT_SETTINGS.weights[key]);
  return {
    dormantAfterDays: clampInt(s.dormantAfterDays, 7, 1095, DEFAULT_SETTINGS.dormantAfterDays),
    newCustomerDays: clampInt(s.newCustomerDays, 1, 365, DEFAULT_SETTINGS.newCustomerDays),
    repeatMinOrders: clampInt(s.repeatMinOrders, 2, 50, DEFAULT_SETTINGS.repeatMinOrders),
    highValueTopPercent: clampInt(s.highValueTopPercent, 1, 50, DEFAULT_SETTINGS.highValueTopPercent),
    unansweredRiskDays: clampInt(s.unansweredRiskDays, 1, 60, DEFAULT_SETTINGS.unansweredRiskDays),
    weights,
  };
}

// ---- what goes in ---------------------------------------------------------------------

export interface CallFact {
  id: string;
  at: Date;
  direction: 'inbound' | 'outbound' | 'unknown';
  /** The two sides talked. */
  connected: boolean;
  /** An incoming call nobody picked up. */
  missed: boolean;
  durationSeconds?: number;
  employee?: string;
  sessionId?: string;
  headline?: string;
  sentiment?: string;
  score?: number;
  outcome?: string;
  /** Promises the salesperson made on the call (the call report's follow-ups). */
  followUps: string[];
  riskSignals: string[];
  buyingSignals: string[];
}

export interface ThreeSixtyInput {
  now: Date;
  settings: IntelligenceSettings;
  /** When we first heard of them (their earliest record), if any record is dated. */
  firstSeenAt?: Date;
  /** The latest thing that happened with them (any record, email or call). */
  lastActivityAt?: Date;
  orders: { count: number; totalValue: number; lastOrderAt?: Date; firstOrderAt?: Date };
  /** Lifetime revenue of every paying customer of this business — to tell high value from ordinary. */
  peerRevenues: number[];
  deals: { open: number; won: number; lost: number };
  quotes: { id: string; number?: string; date?: Date; state: string; amount: number }[];
  /** Whether payments are recorded at all; without them "unpaid" would be a guess. */
  paymentsTracked: boolean;
  payment: { billed: number; paid: number | null; outstanding: number | null; overdueAmount: number; status: string };
  invoices: { id: string; number?: string; amount: number; outstanding: number | null; overdue: boolean; dueDate?: Date }[];
  email: { received: number; sent: number; unanswered: number; lastReceivedAt?: Date; lastSentAt?: Date; oldestUnansweredAt?: Date; weReplyInHours: number | null };
  unansweredEmails: { id: string; subject: string; at: Date }[];
  calls: CallFact[];
  followUps: { title: string; dueDate?: Date; status: 'pending' | 'done' | 'dismissed' }[];
  /** The latest enquiry, and whether anyone has acted on it since. */
  inquiry: { open: boolean; actioned: boolean; latestAt?: Date };
  crmLost: boolean;
  /** The AI report's reading of the customer's sentiment, when one was written. */
  aiSentiment?: 'positive' | 'neutral' | 'negative' | 'mixed';
}

// ---- what comes out ------------------------------------------------------------------------

export type RelationshipStage = 'new' | 'existing' | 'repeat' | 'lost';
export type BadgeTone = 'accent' | 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export interface Badge {
  key: 'new' | 'existing' | 'repeat' | 'lost' | 'active' | 'dormant' | 'at_risk' | 'high_value';
  label: string;
  tone: BadgeTone;
  /** Why it applies — the facts, in words. */
  reasons: string[];
}

export interface Relationship {
  stage: RelationshipStage;
  active: boolean;
  atRisk: boolean;
  highValue: boolean;
  badges: Badge[];
  /** What they bought — only completed orders count. */
  purchaseHistory: { completedOrders: number; lifetimeRevenue: number; firstPurchaseAt?: Date; lastPurchaseAt?: Date };
  /** That we know them — contact, emails, calls, quotations — whether or not they bought. */
  relationshipHistory: { firstSeenAt?: Date; lastInteractionAt?: Date; interactions: number; emails: number; calls: number; quotations: number };
}

export interface HealthPart {
  key: HealthComponent;
  label: string;
  /** Null when there is nothing to judge it on — then it doesn't count either way. */
  score: number | null;
  weight: number;
  reason: string;
}

export interface Health {
  /** Null when fewer than two parts have anything to go on. */
  score: number | null;
  band: 'healthy' | 'needs_attention' | 'at_risk' | 'not_enough_data';
  bandLabel: string;
  parts: HealthPart[];
  explanation: string;
}

export interface CallStats {
  total: number;
  incoming: number;
  outgoing: number;
  connected: number;
  missed: number;
  notConnected: number;
  talkSeconds: number;
  averageSeconds: number | null;
  lastCallAt?: Date;
  /** Calls per month over the span between the first and last call (null with fewer than two). */
  perMonth: number | null;
  /** Call scores oldest first, with what changed. */
  scoreTrend: { at: Date; score: number; sessionId?: string }[];
  scoreChange: string | null;
}

export interface EvidenceRef {
  kind: 'email' | 'call' | 'quotation' | 'invoice' | 'follow_up' | 'inquiry' | 'deal';
  id?: string;
  label: string;
}

export interface NextAction {
  /** Stable for the same situation, so accepting or dismissing it sticks. */
  key: string;
  action: string;
  reason: string;
  evidence: EvidenceRef[];
  priority: 'high' | 'medium' | 'low';
  deadline: string;
  outcome: string;
  source: 'rules' | 'ai';
}

// ---- helpers ----------------------------------------------------------------------------------

const days = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (date: Date, now: Date) => {
  const n = days(date, now);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
};
const shortDate = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const money = (value: number) => Math.round(value).toLocaleString('en-IN');

// ---- relationship -------------------------------------------------------------------------------

export function classifyRelationship(input: ThreeSixtyInput): Relationship {
  const { now, settings: s, orders } = input;
  const calls = input.calls.length;
  const emails = input.email.received + input.email.sent;
  const quotations = input.quotes.length;
  const interactions = calls + emails + quotations + input.deals.open + input.deals.won + input.deals.lost;
  const lastAt = input.lastActivityAt;
  const sinceLast = lastAt ? days(lastAt, now) : null;
  const sinceFirst = input.firstSeenAt ? days(input.firstSeenAt, now) : null;
  const badges: Badge[] = [];

  // Purchase history and relationship history are separate: talking to us is not buying from us.
  let stage: RelationshipStage;
  if (orders.count >= s.repeatMinOrders) {
    stage = 'repeat';
    badges.push({
      key: 'repeat',
      label: 'Repeat customer',
      tone: 'success',
      reasons: [
        `${plural(orders.count, 'completed order')} worth ${money(orders.totalValue)}${orders.lastOrderAt ? `, the latest on ${shortDate(orders.lastOrderAt)}` : ''}.`,
        `Repeat means at least ${s.repeatMinOrders} completed orders.`,
      ],
    });
  } else if (orders.count === 0 && input.crmLost) {
    stage = 'lost';
    badges.push({ key: 'lost', label: 'Lost', tone: 'danger', reasons: ['No completed order, and every deal or quotation with them was lost or rejected.'] });
  } else if (orders.count >= 1) {
    // Bought from us, fewer times than "repeat" asks for.
    stage = 'existing';
    badges.push({
      key: 'existing',
      label: 'Existing customer',
      tone: 'info',
      reasons: [
        `${plural(orders.count, 'completed order')} worth ${money(orders.totalValue)}${orders.lastOrderAt ? `, the latest on ${shortDate(orders.lastOrderAt)}` : ''}.`,
        ...(orders.count > 1 ? [`Repeat means at least ${s.repeatMinOrders} completed orders.`] : []),
      ],
    });
  } else if (sinceFirst !== null && sinceFirst > s.newCustomerDays && interactions > 0) {
    // Known for a while, nothing bought: an established relationship, not a purchasing customer.
    stage = 'existing';
    badges.push({
      key: 'existing',
      label: 'Existing contact',
      tone: 'info',
      reasons: [
        `Known since ${shortDate(input.firstSeenAt!)} (${plural(interactions, 'interaction')}), but no completed order yet.`,
        'Talking to us is not buying from us: they are not counted as a purchasing customer.',
      ],
    });
  } else {
    stage = 'new';
    badges.push({
      key: 'new',
      label: 'New customer',
      tone: 'accent',
      reasons: [
        'No completed order recorded.',
        input.firstSeenAt ? `First seen ${ago(input.firstSeenAt, now)} (new means within ${s.newCustomerDays} days, or no history yet).` : 'No earlier history recorded.',
      ],
    });
  }

  // Active or dormant: only meaningful once there has been something to go quiet after.
  const active = sinceLast !== null && sinceLast <= s.dormantAfterDays;
  if (active) {
    badges.push({ key: 'active', label: 'Active', tone: 'success', reasons: [`Last interaction ${ago(lastAt!, now)} (within ${s.dormantAfterDays} days).`] });
  } else if (sinceLast !== null && (orders.count > 0 || interactions > 1)) {
    badges.push({
      key: 'dormant',
      label: 'Dormant',
      tone: 'warning',
      reasons: [`Nothing for ${sinceLast} days (dormant after ${s.dormantAfterDays}); last interaction on ${shortDate(lastAt!)}.`],
    });
  }

  // At risk: things gone wrong that are still open — each a recorded fact.
  const risk: string[] = [];
  const oldest = input.email.oldestUnansweredAt;
  if (oldest && days(oldest, now) >= s.unansweredRiskDays)
    risk.push(`An email of theirs has waited ${days(oldest, now)} days for an answer (${plural(input.email.unanswered, 'unanswered email')}).`);
  if (input.paymentsTracked && input.payment.overdueAmount > 0) risk.push(`${money(input.payment.overdueAmount)} is overdue for payment.`);
  const overdueFollowUps = input.followUps.filter((f) => f.status === 'pending' && f.dueDate && f.dueDate.getTime() < now.getTime() - DAY_MS);
  if (overdueFollowUps.length) risk.push(`${plural(overdueFollowUps.length, 'follow-up')} past due.`);
  const recentRejected = input.quotes.filter((q) => (q.state === 'rejected' || q.state === 'expired') && q.date && days(q.date, now) <= 60);
  if (recentRejected.length) risk.push(`${plural(recentRejected.length, 'recent quotation')} rejected or expired.`);
  const missedRecent = input.calls.filter((c) => c.missed && days(c.at, now) <= 14);
  if (missedRecent.length) risk.push(`${plural(missedRecent.length, 'missed call')} from them in the last two weeks.`);
  const lastScored = [...input.calls].filter((c) => c.sentiment).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (lastScored?.sentiment && /neg/i.test(lastScored.sentiment)) risk.push(`Their latest call (${shortDate(lastScored.at)}) was negative in tone.`);
  const riskSignals = input.calls.filter((c) => days(c.at, now) <= 60).flatMap((c) => c.riskSignals);
  if (riskSignals.length) risk.push(`Risk on a recent call: “${riskSignals[0]}”.`);
  const atRisk = risk.length > 0 && stage !== 'lost';
  if (atRisk) badges.push({ key: 'at_risk', label: 'At risk', tone: 'danger', reasons: risk });

  // High value: among this business's paying customers, by real revenue — never by quotations.
  let highValue = false;
  if (orders.count > 0 && orders.totalValue > 0 && input.peerRevenues.length >= 5) {
    const sorted = [...input.peerRevenues].filter((v) => v > 0).sort((a, b) => b - a);
    const cut = sorted[Math.max(0, Math.ceil((sorted.length * s.highValueTopPercent) / 100) - 1)];
    if (cut !== undefined && orders.totalValue >= cut) {
      highValue = true;
      badges.push({
        key: 'high_value',
        label: 'High value',
        tone: 'accent',
        reasons: [
          `Lifetime revenue ${money(orders.totalValue)} — in the top ${s.highValueTopPercent}% of the business's ${sorted.length} paying customers (from ${money(cut)}).`,
        ],
      });
    }
  }

  return {
    stage,
    active,
    atRisk,
    highValue,
    badges,
    purchaseHistory: { completedOrders: orders.count, lifetimeRevenue: orders.totalValue, firstPurchaseAt: orders.firstOrderAt, lastPurchaseAt: orders.lastOrderAt },
    relationshipHistory: { firstSeenAt: input.firstSeenAt, lastInteractionAt: lastAt, interactions, emails, calls, quotations },
  };
}

// ---- health ---------------------------------------------------------------------------------------

const HEALTH_LABEL: Record<HealthComponent, string> = {
  engagement: 'Engagement',
  purchase: 'Purchase history',
  payment: 'Payment reliability',
  responsiveness: 'Our responsiveness',
  sentiment: 'Sentiment',
  conversion: 'Deal conversion',
  followUp: 'Follow-up status',
};
const SENTIMENT_SCORE: Record<string, number> = { positive: 100, neutral: 70, mixed: 55, negative: 25 };

function sentimentScore(value?: string): number | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v.includes('pos')) return SENTIMENT_SCORE.positive;
  if (v.includes('neg')) return SENTIMENT_SCORE.negative;
  if (v.includes('mix')) return SENTIMENT_SCORE.mixed;
  if (v.includes('neu')) return SENTIMENT_SCORE.neutral;
  return undefined;
}

export function scoreHealth(input: ThreeSixtyInput): Health {
  const { now, settings } = input;
  const parts: HealthPart[] = [];
  const part = (key: HealthComponent, score: number | null, reason: string) =>
    parts.push({ key, label: HEALTH_LABEL[key], score: score === null ? null : Math.round(Math.min(100, Math.max(0, score))), weight: settings.weights[key], reason });

  // Engagement: how recently anything happened.
  if (input.lastActivityAt) {
    const d = days(input.lastActivityAt, now);
    const score = d <= 7 ? 100 : d <= 30 ? 80 : d <= 90 ? 55 : d <= 180 ? 30 : 10;
    part('engagement', score, `Last interaction ${ago(input.lastActivityAt, now)}.`);
  } else part('engagement', null, 'No dated interaction recorded.');

  // Purchase history: completed orders only.
  if (input.orders.count > 0) {
    const score = input.orders.count >= 3 ? 100 : input.orders.count === 2 ? 85 : 65;
    part('purchase', score, `${plural(input.orders.count, 'completed order')} worth ${money(input.orders.totalValue)}.`);
  } else part('purchase', null, 'No completed order yet — not counted against them.');

  // Payment reliability: only when payments are recorded and something was billed.
  if (!input.paymentsTracked) part('payment', null, 'Payments are not recorded for this business.');
  else if (input.payment.billed <= 0) part('payment', null, 'Nothing billed yet.');
  else {
    const overdueShare = input.payment.overdueAmount / input.payment.billed;
    part(
      'payment',
      100 - overdueShare * 100,
      input.payment.overdueAmount > 0 ? `${money(input.payment.overdueAmount)} of ${money(input.payment.billed)} billed is overdue.` : `Nothing overdue of ${money(input.payment.billed)} billed.`,
    );
  }

  // Our responsiveness: their emails answered, and how fast.
  if (input.email.received > 0) {
    let score = 100 - Math.min(60, input.email.unanswered * 20);
    if (input.email.weReplyInHours !== null && input.email.weReplyInHours > 48) score -= 20;
    else if (input.email.weReplyInHours !== null && input.email.weReplyInHours > 24) score -= 10;
    part(
      'responsiveness',
      score,
      `${plural(input.email.unanswered, 'email')} of theirs unanswered${input.email.weReplyInHours !== null ? `; we usually reply in ${input.email.weReplyInHours} hours` : ''}.`,
    );
  } else part('responsiveness', null, 'No email from them recorded.');

  // Sentiment: their calls' tone, and the AI report's reading.
  const tones = input.calls.map((c) => sentimentScore(c.sentiment)).filter((v): v is number => v !== undefined);
  const ai = sentimentScore(input.aiSentiment);
  if (ai !== undefined) tones.push(ai);
  if (tones.length) part('sentiment', tones.reduce((a, b) => a + b, 0) / tones.length, `From ${plural(tones.length, 'reading')} (calls${ai !== undefined ? ' and the AI report' : ''}).`);
  else part('sentiment', null, 'No call or AI reading of their tone yet.');

  // Deal conversion: decided deals and quotations.
  const accepted = input.quotes.filter((q) => q.state === 'accepted').length;
  const declined = input.quotes.filter((q) => q.state === 'rejected' || q.state === 'expired').length;
  const won = input.deals.won;
  const lost = input.deals.lost;
  const decided = accepted + declined + won + lost;
  if (decided > 0) part('conversion', ((accepted + won) / decided) * 100, `${accepted + won} won or accepted of ${decided} decided deals and quotations.`);
  else part('conversion', null, 'No deal or quotation decided yet.');

  // Follow-up status: what is due.
  const pending = input.followUps.filter((f) => f.status === 'pending');
  const overdue = pending.filter((f) => f.dueDate && f.dueDate.getTime() < now.getTime() - DAY_MS);
  const somethingWaiting = input.email.unanswered > 0 || input.quotes.some((q) => q.state === 'sent') || (input.inquiry.open && !input.inquiry.actioned);
  if (overdue.length) part('followUp', 30, `${plural(overdue.length, 'follow-up')} past due.`);
  else if (pending.length) part('followUp', 100, `${plural(pending.length, 'follow-up')} planned and on time.`);
  else if (somethingWaiting) part('followUp', 50, 'Something is waiting on us (an email, quotation or enquiry) with no follow-up planned.');
  else part('followUp', null, 'Nothing waiting that needs a follow-up.');

  const counted = parts.filter((p) => p.score !== null && p.weight > 0);
  if (counted.length < 2) {
    return {
      score: null,
      band: 'not_enough_data',
      bandLabel: 'Not enough data',
      parts,
      explanation: 'Fewer than two parts of the score have anything to go on yet — no score rather than a guess.',
    };
  }
  const totalWeight = counted.reduce((sum, p) => sum + p.weight, 0);
  const score = Math.round(counted.reduce((sum, p) => sum + p.score! * p.weight, 0) / totalWeight);
  const band = score >= 75 ? 'healthy' : score >= 50 ? 'needs_attention' : 'at_risk';
  const weakest = [...counted].sort((a, b) => a.score! - b.score!)[0];
  const left = parts.filter((p) => p.score === null).map((p) => p.label.toLowerCase());
  return {
    score,
    band,
    bandLabel: band === 'healthy' ? 'Healthy' : band === 'needs_attention' ? 'Needs attention' : 'At risk',
    parts,
    explanation:
      `Weighted average of ${plural(counted.length, 'part')} (weights ${counted.map((p) => `${p.label.toLowerCase()} ${p.weight}`).join(', ')}).` +
      (weakest && weakest.score! < 75 ? ` Lowest: ${weakest.label.toLowerCase()} (${weakest.score}).` : '') +
      (left.length ? ` Left out for lack of data: ${left.join(', ')}.` : ''),
  };
}

// ---- calls -------------------------------------------------------------------------------------------

export function callStats(calls: CallFact[]): CallStats {
  const sorted = [...calls].sort((a, b) => a.at.getTime() - b.at.getTime());
  const talk = sorted.filter((c) => c.connected && (c.durationSeconds ?? 0) > 0);
  const talkSeconds = talk.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0);
  const first = sorted[0]?.at;
  const last = sorted[sorted.length - 1]?.at;
  const months = first && last ? (last.getTime() - first.getTime()) / (30 * DAY_MS) : 0;
  const scoreTrend = sorted.filter((c) => typeof c.score === 'number').map((c) => ({ at: c.at, score: c.score!, sessionId: c.sessionId }));
  let scoreChange: string | null = null;
  if (scoreTrend.length >= 2) {
    const [prev, latest] = scoreTrend.slice(-2);
    const diff = Math.round((latest.score - prev.score) * 10) / 10;
    scoreChange =
      diff === 0
        ? `The latest call scored the same as the one before (${latest.score}).`
        : `The latest call scored ${latest.score}, ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} from ${prev.score} on the call before.`;
  }
  return {
    total: sorted.length,
    incoming: sorted.filter((c) => c.direction === 'inbound').length,
    outgoing: sorted.filter((c) => c.direction === 'outbound').length,
    connected: sorted.filter((c) => c.connected).length,
    missed: sorted.filter((c) => c.missed).length,
    notConnected: sorted.filter((c) => !c.connected && !c.missed).length,
    talkSeconds,
    averageSeconds: talk.length ? Math.round(talkSeconds / talk.length) : null,
    lastCallAt: last,
    perMonth: sorted.length >= 2 && months > 0 ? Math.round((sorted.length / Math.max(1, months)) * 10) / 10 : null,
    scoreTrend,
    scoreChange,
  };
}

// ---- next best actions ------------------------------------------------------------------------------

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export function nextBestActions(input: ThreeSixtyInput, relationship: Relationship): NextAction[] {
  const { now } = input;
  const actions: NextAction[] = [];
  const today = isoDay(now);
  const inDays = (n: number) => isoDay(new Date(now.getTime() + n * DAY_MS));

  // A reply owed: the oldest unanswered email first.
  const owed = [...input.unansweredEmails].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (owed.length) {
    const oldest = owed[0];
    actions.push({
      key: `reply:${oldest.id}`,
      action: owed.length > 1 ? `Reply to their ${owed.length} unanswered emails, starting with “${oldest.subject || '(no subject)'}”` : `Reply to “${oldest.subject || '(no subject)'}”`,
      reason: `They wrote ${ago(oldest.at, now)} and have had no answer.`,
      evidence: owed.slice(0, 3).map((e) => ({ kind: 'email' as const, id: e.id, label: e.subject || '(no subject)' })),
      priority: days(oldest.at, now) >= 1 ? 'high' : 'medium',
      deadline: today,
      outcome: 'The customer gets an answer before they look elsewhere.',
      source: 'rules',
    });
  }

  // A new enquiry nobody has acted on.
  if (input.inquiry.open && !input.inquiry.actioned && input.inquiry.latestAt) {
    actions.push({
      key: `enquiry:${isoDay(input.inquiry.latestAt)}`,
      action: 'Respond to their enquiry',
      reason: `Their enquiry came in ${ago(input.inquiry.latestAt, now)} and nobody has emailed or quoted since.`,
      evidence: [{ kind: 'inquiry', label: `Enquiry of ${shortDate(input.inquiry.latestAt)}` }],
      priority: 'high',
      deadline: today,
      outcome: 'A first answer while their interest is fresh.',
      source: 'rules',
    });
  }

  // A sent quotation with no decision for a while.
  for (const quote of input.quotes.filter((q) => q.state === 'sent' && q.date && days(q.date, now) >= 3).slice(0, 2)) {
    actions.push({
      key: `quote:${quote.id}`,
      action: `Follow up on quotation ${quote.number ?? ''}`.trim(),
      reason: `Sent ${ago(quote.date!, now)}, worth ${money(quote.amount)}, and still undecided.`,
      evidence: [{ kind: 'quotation', id: quote.id, label: `Quotation ${quote.number ?? ''}`.trim() }],
      priority: days(quote.date!, now) >= 7 ? 'high' : 'medium',
      deadline: inDays(1),
      outcome: 'A decision on the quotation — or what is stopping it.',
      source: 'rules',
    });
  }

  // Money overdue — only when payments are really recorded.
  if (input.paymentsTracked) {
    const overdue = input.invoices.filter((i) => i.overdue && (i.outstanding ?? 0) > 0);
    if (overdue.length) {
      actions.push({
        key: `payment:${overdue.map((i) => i.id).sort().join(',')}`,
        action: 'Send a payment reminder',
        reason: `${plural(overdue.length, 'invoice')} overdue, ${money(overdue.reduce((s, i) => s + (i.outstanding ?? 0), 0))} outstanding.`,
        evidence: overdue.slice(0, 3).map((i) => ({ kind: 'invoice' as const, id: i.id, label: `Invoice ${i.number ?? ''}`.trim() })),
        priority: 'high',
        deadline: inDays(2),
        outcome: 'The overdue amount collected.',
        source: 'rules',
      });
    }
  }

  // Promises made on calls, and calls nobody returned.
  const latestCall = [...input.calls].filter((c) => c.followUps.length).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (latestCall && days(latestCall.at, now) <= 30) {
    actions.push({
      key: `call-promise:${latestCall.id}`,
      action: `Do what was promised on the call of ${shortDate(latestCall.at)}: ${latestCall.followUps[0]}`,
      reason: `The call report lists ${plural(latestCall.followUps.length, 'follow-up')} from that call.`,
      evidence: [{ kind: 'call', id: latestCall.sessionId ?? latestCall.id, label: latestCall.headline ?? `Call of ${shortDate(latestCall.at)}` }],
      priority: 'medium',
      deadline: inDays(1),
      outcome: 'The customer sees the promise kept.',
      source: 'rules',
    });
  }
  const missed = [...input.calls].filter((c) => c.missed).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const calledBackAfter = missed && input.calls.some((c) => c.direction === 'outbound' && c.at.getTime() > missed.at.getTime());
  if (missed && !calledBackAfter && days(missed.at, now) <= 14) {
    actions.push({
      key: `callback:${missed.id}`,
      action: 'Call them back',
      reason: `They called ${ago(missed.at, now)} and nobody picked up; no call back since.`,
      evidence: [{ kind: 'call', id: missed.id, label: `Missed call of ${shortDate(missed.at)}` }],
      priority: 'high',
      deadline: today,
      outcome: 'Whatever they rang about, answered.',
      source: 'rules',
    });
  }

  // A good customer gone quiet.
  if (relationship.badges.some((b) => b.key === 'dormant') && relationship.purchaseHistory.completedOrders > 0) {
    actions.push({
      key: `reconnect:${relationship.relationshipHistory.lastInteractionAt ? isoDay(relationship.relationshipHistory.lastInteractionAt) : 'never'}`,
      action: 'Reconnect with them',
      reason: `${plural(relationship.purchaseHistory.completedOrders, 'past order')}, but nothing for a long time.`,
      evidence: [],
      priority: relationship.highValue ? 'high' : 'medium',
      deadline: inDays(7),
      outcome: 'A repeat order from a customer who already trusts you.',
      source: 'rules',
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return actions.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
