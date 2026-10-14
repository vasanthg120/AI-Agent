import type { KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheckCircle, FiInbox } from 'react-icons/fi';
import { Avatar, Badge, EmptyState, Skeleton } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import type { EmailIntelligenceItem } from '@/services/emailIntelligenceService';
import { CATEGORY_LABEL, CATEGORY_VARIANT, formatWhen, responseBadge } from '../emailResponseLabels';
import styles from '../email-intelligence.module.css';

// Priority (business importance) and urgency (time pressure) are two
// different axes the AI sets independently (see EMAIL_INTENT_SYSTEM_PROMPT's
// own criteria). Deliberately worded differently from the priority badge
// ("Reply today"/"Reply soon", not "urgent"/"high") so two badges with the
// same-looking word don't sit side by side reading as a duplicate — and only
// shown for urgent/high, the cases that actually mean "don't let this sit".
// Only meaningful while a reply is still owed, so it is hidden once answered.
const URGENCY_LABEL: Record<string, string> = { urgent: 'Reply today', high: 'Reply soon' };
const URGENCY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning' };

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
    <div className={styles.inboxList} role="list">
      {items.map((item, i) => {
        const state = responseBadge(item);
        const answered = item.responseStatus === 'responded';
        const waiting = item.responseStatus === 'needs_response';
        const pressing = waiting && (item.urgency === 'urgent' || item.urgency === 'high');
        const unread = !item.isRead;
        const sender = item.fromName || item.fromAddress;
        const messages = item.threadMessageCount ?? 1;
        // Brought in from mailbox history, or it arrived while the AI was unavailable: no type, no draft yet.
        const unsorted = item.aiRead === false || item.analysisState === 'pending';
        // One line of context under the subject: who spoke last and what they said.
        const lastWord = answered && item.replyPreview ? `You: ${item.replyPreview}` : item.bodyPreview;
        return (
          <motion.div
            key={item._id}
            role="listitem"
            className={clsx(
              styles.inboxRow,
              unread && styles.inboxRowUnread,
              pressing && (item.urgency === 'urgent' ? styles.listItemUrgent : styles.listItemHigh),
            )}
            tabIndex={0}
            onClick={() => onSelect(item)}
            onKeyDown={(event) => activate(event, item)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            // Only the first page staggers; rows added by "Load more" appear promptly.
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1], delay: i < 25 ? Math.min(i, 12) * 0.025 : 0 }}
          >
            <Avatar name={sender} size="sm" className={styles.senderAvatar} />
            <div className={styles.inboxMain}>
              <div className={styles.inboxTop}>
                <span className={styles.inboxSender} title={item.fromAddress}>
                  {unread && <span className={styles.unreadDot} role="img" aria-label="Unread" />}
                  {sender}
                </span>
                {item.matchedBusinessName && <span className={styles.inboxCompany}>{item.matchedBusinessName}</span>}
                {messages > 1 && <span className={styles.inboxCount}>{messages} messages</span>}
                <span className={styles.inboxTime} title={formatWhen(item.receivedAt)}>
                  {formatAgo(item.receivedAt)}
                </span>
              </div>
              <div className={styles.inboxSubject}>{item.subject || '(no subject)'}</div>
              {lastWord && <div className={styles.inboxPreview}>{lastWord}</div>}
            </div>
            {/* At most three: where it stands, how soon, and anything unusual about it. */}
            <div className={styles.inboxBadges}>
              <Badge variant={state.variant}>{state.label}</Badge>
              {pressing && <Badge variant={URGENCY_VARIANT[item.urgency]}>{URGENCY_LABEL[item.urgency]}</Badge>}
              {answered &&
                item.category &&
                (item.category === 'waiting_for_customer' || item.category === 'follow_up_required') && (
                  <Badge variant={CATEGORY_VARIANT[item.category]}>{CATEGORY_LABEL[item.category]}</Badge>
                )}
              {unsorted
                ? waiting && <Badge variant="neutral">Not read by AI yet</Badge>
                : waiting &&
                  (item.sentiment === 'frustrated' || item.sentiment === 'negative') && (
                    <Badge variant="danger">Unhappy</Badge>
                  )}
              {!unsorted && <span className={styles.inboxIntent}>{intentLabel(item.intent)}</span>}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// "2h ago" for today's mail, the date for older mail — the exact time is in the tooltip.
function formatAgo(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
