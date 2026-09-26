import type { KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheckCircle, FiInbox } from 'react-icons/fi';
import { Avatar, Badge, EmptyState, Skeleton } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import type { EmailIntelligenceItem } from '@/services/emailIntelligenceService';
import { formatWhen, responseBadge } from '../emailResponseLabels';
import styles from '../email-intelligence.module.css';

const PRIORITY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };
const SENTIMENT_VARIANT: Record<string, BadgeVariant> = { negative: 'danger', frustrated: 'danger', positive: 'success', neutral: 'neutral' };
const CONFIDENCE_VARIANT: Record<string, BadgeVariant> = { exact: 'success', domain: 'info', fuzzy: 'warning', none: 'neutral' };

// Priority (business importance) and urgency (time pressure) are two
// different axes the AI sets independently (see EMAIL_INTENT_SYSTEM_PROMPT's
// own criteria). Deliberately worded differently from the priority badge
// ("Reply today"/"Reply soon", not "urgent"/"high") so two badges with the
// same-looking word don't sit side by side reading as a duplicate — and only
// shown for urgent/high, the cases that actually mean "don't let this sit".
// Only meaningful while a reply is still owed, so it is hidden once answered.
const URGENCY_LABEL: Record<string, string> = { urgent: 'Reply today', high: 'Reply soon' };
const URGENCY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning' };

const FROM_ROLE_LABEL: Record<string, string> = {
  internal: 'Internal',
  customer: 'Customer',
  vendor: 'Vendor',
  external_other: 'External',
};

function intentLabel(intent: string): string {
  return intent.replace(/_/g, ' ');
}

// Rows arrive already in the order the backend sorted them (urgency / newest /
// oldest), so paging through the queue keeps one consistent order — this used
// to re-sort whichever page it was handed, which reshuffled across pages.
export function EmailIntelligenceList({
  items,
  isLoading,
  emptyTitle,
  emptyMessage,
  celebrate,
  onSelect,
}: {
  items: EmailIntelligenceItem[] | undefined;
  isLoading: boolean;
  emptyTitle: string;
  emptyMessage: string;
  /** The empty queue is good news (nothing waiting) — show it as such. */
  celebrate?: boolean;
  onSelect: (item: EmailIntelligenceItem) => void;
}) {
  if (isLoading || !items) {
    return (
      <div className={styles.formGrid}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={styles.skeletonRow}>
            <Skeleton width={36} height={36} variant="circle" />
            <div className={styles.skeletonText}>
              <Skeleton height={14} width="55%" />
              <Skeleton height={11} width="35%" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState icon={celebrate ? FiCheckCircle : FiInbox} title={emptyTitle} description={emptyMessage} />;
  }

  const activate = (event: KeyboardEvent, item: EmailIntelligenceItem) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(item);
    }
  };

  return (
    <div className={styles.formGrid} role="list">
      {items.map((item, i) => {
        const state = responseBadge(item);
        const answered = item.responseStatus === 'responded';
        const pressing = !answered && item.responseStatus === 'needs_response' && (item.urgency === 'urgent' || item.urgency === 'high');
        return (
          <motion.div
            key={item._id}
            role="listitem"
            className={clsx(
              styles.listItem,
              !item.isRead && styles.listItemUnread,
              pressing && (item.urgency === 'urgent' ? styles.listItemUrgent : styles.listItemHigh),
            )}
            tabIndex={0}
            onClick={() => onSelect(item)}
            onKeyDown={(event) => activate(event, item)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            // Only the first page staggers; rows added by "Load more" appear promptly.
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1], delay: i < 25 ? Math.min(i, 12) * 0.025 : 0 }}
          >
            <Avatar name={item.fromAddress} size="sm" className={styles.senderAvatar} />
            <div className={styles.listItemMain}>
              <span className={styles.listItemTitle}>
                {!item.isRead && <span className={styles.unreadDot} role="img" aria-label="Unread" />}
                {item.subject || '(no subject)'}
              </span>
              <span className={styles.listItemMeta}>
                From {item.fromAddress}
                {item.fromRole ? ` (${FROM_ROLE_LABEL[item.fromRole]})` : ''} · {formatWhen(item.receivedAt)}
                {item.matchedBusinessName ? ` · ${item.matchedBusinessName}` : ''}
                {answered && item.respondedAt ? ` · answered ${formatWhen(item.respondedAt)}` : ''}
              </span>
            </div>
            <div className={styles.badgeRow}>
              <Badge variant={state.variant}>{state.label}</Badge>
              <Badge variant="accent">{intentLabel(item.intent)}</Badge>
              <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority} priority</Badge>
              {!answered && (item.urgency === 'urgent' || item.urgency === 'high') && item.responseStatus === 'needs_response' && (
                <Badge variant={URGENCY_VARIANT[item.urgency]}>{URGENCY_LABEL[item.urgency]}</Badge>
              )}
              {item.sentiment !== 'neutral' && <Badge variant={SENTIMENT_VARIANT[item.sentiment] ?? 'neutral'}>{item.sentiment}</Badge>}
              {item.matchConfidence !== 'none' && <Badge variant={CONFIDENCE_VARIANT[item.matchConfidence]}>{item.matchConfidence} match</Badge>}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
