import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Badge, Skeleton } from '@/components/ui';
import { emailIntelligenceService } from '@/services/emailIntelligenceService';
import { formatWhen, responseBadge } from '../emailResponseLabels';
import styles from '../email-intelligence.module.css';

// The conversation this email belongs to: every stored message in the thread,
// oldest first, each showing whether it has been answered — so it is clear what
// was asked, what has been replied to, and that the history is all still here.
// A one-message thread has nothing to show beyond the email itself.
export function EmailThreadTimeline({ itemId }: { itemId: string }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['email-intelligence-items', 'thread', itemId],
    queryFn: () => emailIntelligenceService.getThread(itemId),
  });

  if (isLoading) return <Skeleton height={72} />;
  if (isError) {
    return (
      <div className={styles.card} role="alert">
        Couldn't load the conversation.{' '}
        <button type="button" className={styles.linkButton} onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data || data.messages.length < 2) return null;

  return (
    <div className={styles.card}>
      <div className={styles.fieldLabel}>Conversation · {data.messages.length} messages</div>
      <ol className={styles.thread}>
        {data.messages.map((message) => {
          const badge = responseBadge(message);
          const current = message._id === itemId;
          return (
            <li key={message._id} className={clsx(styles.threadItem, current && styles.threadCurrent)} aria-current={current || undefined}>
              <div className={styles.threadHeader}>
                <span className={styles.threadFrom}>{message.fromAddress}</span>
                <span className={styles.listItemMeta}>{formatWhen(message.receivedAt)}</span>
              </div>
              {message.bodyPreview && <div className={styles.threadPreview}>{message.bodyPreview}</div>}
              <div className={styles.badgeRow}>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                {message.respondedAt && message.responseStatus === 'responded' && (
                  <span className={styles.listItemMeta}>{formatWhen(message.respondedAt)}</span>
                )}
                {current && <Badge variant="accent">This email</Badge>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
