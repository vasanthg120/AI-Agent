import { Badge, Skeleton } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import type { EmailIntelligenceItem } from '@/services/emailIntelligenceService';
import styles from '../email-intelligence.module.css';

const PRIORITY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };
const SENTIMENT_VARIANT: Record<string, BadgeVariant> = { negative: 'danger', frustrated: 'danger', positive: 'success', neutral: 'neutral' };
const CONFIDENCE_VARIANT: Record<string, BadgeVariant> = { exact: 'success', domain: 'info', fuzzy: 'warning', none: 'neutral' };

// Priority (business importance) and urgency (time pressure) are two
// different axes the AI sets independently (see EMAIL_INTENT_SYSTEM_PROMPT's
// own criteria) — but until now urgency was computed, stored, and used in
// Business Intelligence's breakdown, yet never actually shown anywhere a
// salesperson triaging their own inbox could see it. Deliberately worded
// differently from the priority badge ("Reply today"/"Reply soon", not
// "urgent"/"high") so two badges with the same-looking word don't sit side
// by side reading as a duplicate — and only shown for urgent/high (the cases
// that actually mean "don't let this sit"), same restraint as the sentiment/
// matchConfidence badges below that only appear when they carry a real signal.
const URGENCY_LABEL: Record<string, string> = { urgent: 'Reply today', high: 'Reply soon' };
const URGENCY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning' };

// Higher first — the row order used to be pure receivedAt (newest first),
// which meant an urgent complaint from yesterday could sit below a dozen
// routine "thanks!" replies from this morning. Urgency (time pressure) ranks
// above priority (importance) since this is a work queue — what needs
// answering soonest should surface first, importance breaks ties within
// that, and receivedAt is the final tiebreaker so same-severity items still
// read newest-first like before.
const SEVERITY_RANK: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

function bySeverity(a: EmailIntelligenceItem, b: EmailIntelligenceItem): number {
  return (
    (SEVERITY_RANK[b.urgency] ?? 0) - (SEVERITY_RANK[a.urgency] ?? 0) ||
    (SEVERITY_RANK[b.priority] ?? 0) - (SEVERITY_RANK[a.priority] ?? 0) ||
    new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );
}

// Phase 17 — one compact status badge per row, reusing the existing Badge
// palette (no new CSS). Absent (pre-Phase-17 items) renders nothing, not a
// guessed default.
const AI_STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft_ready: 'success',
  no_reply_needed: 'neutral',
  awaiting_customer_response: 'info',
  validation_failed: 'danger',
};
const AI_STATUS_LABEL: Record<string, string> = {
  draft_ready: 'Draft Ready',
  no_reply_needed: 'No Reply Needed',
  awaiting_customer_response: 'Awaiting Customer',
  validation_failed: 'Needs Review',
};
const FROM_ROLE_LABEL: Record<string, string> = {
  internal: 'Internal',
  customer: 'Customer',
  vendor: 'Vendor',
  external_other: 'External',
};

function intentLabel(intent: string): string {
  return intent.replace(/_/g, ' ');
}

export function EmailIntelligenceList({
  items,
  isLoading,
  onSelect,
}: {
  items: EmailIntelligenceItem[] | undefined;
  isLoading: boolean;
  onSelect: (item: EmailIntelligenceItem) => void;
}) {
  if (isLoading || !items) return <Skeleton height={280} />;
  if (items.length === 0) return <div className={styles.emptyState}>No emails in this queue yet.</div>;

  const sortedItems = [...items].sort(bySeverity);

  return (
    <div className={styles.formGrid}>
      {sortedItems.map((item) => (
        <div key={item._id} className={styles.listItem} onClick={() => onSelect(item)}>
          <div className={styles.listItemMain}>
            <span className={styles.listItemTitle}>{item.subject || '(no subject)'}</span>
            <span className={styles.listItemMeta}>
              From {item.fromAddress}
              {item.fromRole ? ` (${FROM_ROLE_LABEL[item.fromRole]})` : ''} · {new Date(item.receivedAt).toLocaleString()}
              {item.matchedBusinessName ? ` · ${item.matchedBusinessName}` : ''}
            </span>
          </div>
          <div className={styles.badgeRow}>
            {item.aiStatus && <Badge variant={AI_STATUS_VARIANT[item.aiStatus]}>{AI_STATUS_LABEL[item.aiStatus]}</Badge>}
            <Badge variant="accent">{intentLabel(item.intent)}</Badge>
            <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority} priority</Badge>
            {(item.urgency === 'urgent' || item.urgency === 'high') && (
              <Badge variant={URGENCY_VARIANT[item.urgency]}>{URGENCY_LABEL[item.urgency]}</Badge>
            )}
            {item.sentiment !== 'neutral' && (
              <Badge variant={SENTIMENT_VARIANT[item.sentiment] ?? 'neutral'}>{item.sentiment}</Badge>
            )}
            {item.matchConfidence !== 'none' && (
              <Badge variant={CONFIDENCE_VARIANT[item.matchConfidence]}>{item.matchConfidence} match</Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
