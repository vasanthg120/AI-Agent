import { useQuery } from '@tanstack/react-query';
import { Badge, Modal, Skeleton } from '@/components/ui';
import { emailAnalyticsService } from '@/services/emailAnalyticsService';
import styles from '../business-intelligence.module.css';

// Shared detail modal for the Sent/Missed Email Analytics pages' full-list
// record browser — one implementation, so the two pages can never render
// this differently.
export function EmailDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: item, isLoading } = useQuery({
    queryKey: ['bi-email-detail', id],
    queryFn: () => emailAnalyticsService.getOne(id!),
    enabled: !!id,
  });

  // Fetched live from Outlook, separately from the item above — bodyPreview
  // on `item` is only Graph's ~255-char snippet captured once at ingest.
  // This can fail on its own (e.g. a stale Outlook token) without breaking
  // the rest of the modal, which still has real subject/from/status/dates
  // from `item` to show — falls back to bodyPreview below when it does.
  const {
    data: body,
    isLoading: bodyLoading,
    isError: bodyError,
  } = useQuery({
    queryKey: ['bi-email-body', id],
    queryFn: () => emailAnalyticsService.getBody(id!),
    enabled: !!id,
    retry: false,
  });

  return (
    <Modal open={!!id} onClose={onClose} title={item?.subject || 'Email detail'} maxWidth={680}>
      <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {isLoading || !item ? (
          <Skeleton height={160} />
        ) : (
          <>
            <div className={styles.badgeRow}>
              <Badge variant="accent">{item.intent}</Badge>
              <Badge variant={item.priority === 'urgent' || item.priority === 'high' ? 'danger' : 'neutral'}>
                {item.priority} priority
              </Badge>
              <Badge variant="neutral">{item.status}</Badge>
              {item.sentAt && <Badge variant="success">Sent (AI draft)</Badge>}
              {item.externalReplyDetectedAt && <Badge variant="success">Replied in Outlook</Badge>}
            </div>
            <div>
              <div className={styles.sectionTitle}>From</div>
              <div>{item.matchedBusinessName ?? item.fromAddress}</div>
              <div className={styles.fadeCaption}>{item.fromAddress}</div>
            </div>
            <div>
              <div className={styles.sectionTitle}>Received</div>
              <div>{new Date(item.receivedAt).toLocaleString()}</div>
            </div>
            {item.sentAt && (
              <div>
                <div className={styles.sectionTitle}>Sent At</div>
                <div>{new Date(item.sentAt).toLocaleString()}</div>
              </div>
            )}
            {item.externalReplyDetectedAt && (
              <div>
                <div className={styles.sectionTitle}>Replied At (in Outlook)</div>
                <div>{new Date(item.externalReplyDetectedAt).toLocaleString()}</div>
              </div>
            )}
            <div>
              <div className={styles.sectionTitle}>Message</div>
              {bodyLoading ? (
                <Skeleton height={200} />
              ) : bodyError || !body ? (
                <>
                  <div className={styles.fadeCaption}>{item.bodyPreview || '(no preview available)'}</div>
                  <p className={styles.fadeCaption} style={{ marginTop: 'var(--space-2)' }}>
                    Couldn't load the full message from Outlook — showing the short preview above instead.
                  </p>
                </>
              ) : body.contentType === 'html' ? (
                <iframe
                  title="Email message"
                  sandbox=""
                  srcDoc={body.content}
                  style={{ width: '100%', height: 360, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: '#fff' }}
                />
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>{body.content || '(empty message)'}</div>
              )}
            </div>
            {item.recommendedAction && (
              <div>
                <div className={styles.sectionTitle}>Recommended Action</div>
                <div>{item.recommendedAction}</div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
