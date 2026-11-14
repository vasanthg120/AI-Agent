// The AI's customer intelligence report, checked before anyone sees it. The AI
// is given the customer's records as numbered evidence (E1, E2 …) and must cite
// them; here every statement is kept only if it cites evidence that was really
// given — a claim with no record behind it is dropped, never shown. Where too
// little is left, the report says "Not enough data" instead of guessing.

export const INTENT_LEVELS = ['very_high', 'high', 'medium', 'low', 'unknown'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'] as const;
export const TRENDS = ['improving', 'stable', 'declining', 'unknown'] as const;
export const BEHAVIOURS = [
  'price_sensitive',
  'quality_focused',
  'speed_focused',
  'relationship_driven',
  'comparison_shopper',
  'repeat_purchaser',
  'decision_oriented',
  'needs_follow_ups',
] as const;
export const PREFERENCE_KINDS = ['product', 'channel', 'contact_time', 'budget', 'delivery', 'service', 'constraint'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;

export type IntentLevel = (typeof INTENT_LEVELS)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

/** One record the AI was shown, by its evidence id. */
export interface EvidenceItem {
  id: string;
  kind: 'email' | 'call' | 'quotation' | 'invoice' | 'deal' | 'inquiry';
  /** The record's own id, to open it. */
  refId?: string;
  label: string;
  at?: Date;
}

export interface IntelligenceReport {
  summary: string;
  buyingIntent: { level: IntentLevel; reason: string; evidence: string[] };
  sentiment: { overall: Sentiment; trend: (typeof TRENDS)[number]; reason: string; evidence: string[] };
  behaviours: { trait: (typeof BEHAVIOURS)[number]; explanation: string; evidence: string[] }[];
  preferences: { kind: (typeof PREFERENCE_KINDS)[number]; text: string; evidence: string[] }[];
  painPoints: { text: string; evidence: string[] }[];
  competitors: { name: string; context: string; pricing?: string; risk: string; response: string; evidence: string[] }[];
  insights: { text: string; basis: 'fact' | 'inference'; evidence: string[] }[];
  recommendations: { action: string; reason: string; priority: (typeof PRIORITIES)[number]; deadline: string; outcome: string; evidence: string[] }[];
  /** How many statements were dropped for citing no real record. */
  dropped: number;
}

type Raw = Record<string, unknown>;
const str = (value: unknown, max = 600): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter((v): v is Raw => !!v && typeof v === 'object') : []);

/** Checks and trims the AI's raw report against the evidence it was given. */
export function validateReport(raw: unknown, evidence: EvidenceItem[]): IntelligenceReport {
  const known = new Set(evidence.map((e) => e.id));
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  let dropped = 0;
  const cited = (value: unknown): string[] => {
    const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toUpperCase()) : [];
    return [...new Set(ids.filter((id) => known.has(id)))];
  };
  // Keeps the items that cite real evidence; counts the ones that don't.
  const supported = <T>(items: Raw[], build: (item: Raw, ids: string[]) => T | null, max: number): T[] => {
    const out: T[] = [];
    for (const item of items) {
      const ids = cited(item.evidence);
      const built = ids.length ? build(item, ids) : null;
      if (built) out.push(built);
      else dropped += 1;
    }
    return out.slice(0, max);
  };

  const intentRaw = (r.buyingIntent ?? {}) as Raw;
  const intentIds = cited(intentRaw.evidence);
  const intentLevel = oneOf(intentRaw.level, INTENT_LEVELS, 'unknown');
  const buyingIntent =
    intentIds.length && intentLevel !== 'unknown'
      ? { level: intentLevel, reason: str(intentRaw.reason), evidence: intentIds }
      : { level: 'unknown' as const, reason: 'Not enough data: nothing in the records shows how likely they are to buy.', evidence: [] };
  if (!intentIds.length && intentLevel !== 'unknown') dropped += 1;

  const sentimentRaw = (r.sentiment ?? {}) as Raw;
  const sentimentIds = cited(sentimentRaw.evidence);
  const overall = oneOf(sentimentRaw.overall, SENTIMENTS, 'unknown');
  const sentiment =
    sentimentIds.length && overall !== 'unknown'
      ? { overall, trend: oneOf(sentimentRaw.trend, TRENDS, 'unknown'), reason: str(sentimentRaw.reason), evidence: sentimentIds }
      : { overall: 'unknown' as const, trend: 'unknown' as const, reason: 'Not enough data: no call or email shows their tone.', evidence: [] };
  if (!sentimentIds.length && overall !== 'unknown') dropped += 1;

  const report: IntelligenceReport = {
    summary: str(r.summary, 1200),
    buyingIntent,
    sentiment,
    behaviours: supported(
      list(r.behaviours),
      (item, ids) => {
        const trait = oneOf(item.trait, BEHAVIOURS, 'decision_oriented');
        return (BEHAVIOURS as readonly string[]).includes(String(item.trait)) && str(item.explanation) ? { trait, explanation: str(item.explanation), evidence: ids } : null;
      },
      6,
    ),
    preferences: supported(
      list(r.preferences),
      (item, ids) => (str(item.text) ? { kind: oneOf(item.kind, PREFERENCE_KINDS, 'product'), text: str(item.text), evidence: ids } : null),
      8,
    ),
    painPoints: supported(list(r.painPoints), (item, ids) => (str(item.text) ? { text: str(item.text), evidence: ids } : null), 6),
    // A competitor only when the customer named one in a record cited here — never invented.
    competitors: supported(
      list(r.competitors),
      (item, ids) =>
        str(item.name, 120)
          ? {
              name: str(item.name, 120),
              context: str(item.context),
              ...(str(item.pricing) ? { pricing: str(item.pricing) } : {}),
              risk: str(item.risk),
              response: str(item.response),
              evidence: ids,
            }
          : null,
      5,
    ),
    insights: supported(
      list(r.insights),
      (item, ids) => (str(item.text) ? { text: str(item.text), basis: item.basis === 'fact' ? ('fact' as const) : ('inference' as const), evidence: ids } : null),
      8,
    ),
    recommendations: supported(
      list(r.recommendations),
      (item, ids) =>
        str(item.action)
          ? {
              action: str(item.action, 300),
              reason: str(item.reason),
              priority: oneOf(item.priority, PRIORITIES, 'medium'),
              deadline: str(item.deadline, 40) || 'This week',
              outcome: str(item.outcome),
              evidence: ids,
            }
          : null,
      5,
    ),
    dropped: 0,
  };
  report.dropped = dropped;
  return report;
}
