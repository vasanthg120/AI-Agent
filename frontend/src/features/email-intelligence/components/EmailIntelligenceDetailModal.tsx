import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiShield, FiZap } from 'react-icons/fi';
import { Badge, Button, Input, Modal } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { emailIntelligenceService, type EmailIntelligenceItem } from '@/services/emailIntelligenceService';
import styles from '../email-intelligence.module.css';

// Phase 17 — labels/variants for the new "AI Decision" card, matching
// EmailIntelligenceList.tsx's aiStatus badge exactly.
const FROM_ROLE_LABEL: Record<string, string> = {
  internal: 'Internal User',
  customer: 'Customer',
  vendor: 'Vendor',
  external_other: 'External Contact',
};
const NEXT_ACTION_LABEL: Record<string, string> = {
  company_reply: 'Company Reply',
  awaiting_customer: 'Waiting for Customer',
  no_action_required: 'No Action Required',
};
const AI_STATUS_LABEL: Record<string, string> = {
  draft_ready: 'Draft Ready',
  no_reply_needed: 'No Reply Needed',
  awaiting_customer_response: 'Awaiting Customer Response',
  validation_failed: 'Needs Review — Validation Failed',
};
const AI_STATUS_VARIANT: Record<string, BadgeVariant> = {
  draft_ready: 'success',
  no_reply_needed: 'neutral',
  awaiting_customer_response: 'info',
  validation_failed: 'danger',
};
// Same priority/urgency distinction as EmailIntelligenceList.tsx's own
// badges (kept in sync — see that file's comment for why the wording
// deliberately differs between the two axes). This modal used to show
// neither: priority/urgency/sentiment were only ever visible from the list
// row, not from the actual review screen where the decision gets made.
const PRIORITY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };
const URGENCY_LABEL: Record<string, string> = { urgent: 'Reply today', high: 'Reply soon' };
const URGENCY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning' };
const SENTIMENT_VARIANT: Record<string, BadgeVariant> = { negative: 'danger', frustrated: 'danger', positive: 'success', neutral: 'neutral' };

export function EmailIntelligenceDetailModal({
  open,
  item,
  onClose,
  onUpdated,
}: {
  open: boolean;
  item: EmailIntelligenceItem | null;
  onClose: () => void;
  onUpdated: (item: EmailIntelligenceItem) => void;
}) {
  const [draft, setDraft] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'regenerate' | 'send' | null>(null);

  useEffect(() => {
    if (open && item) {
      setDraft(item.finalDraftReply ?? item.draftReply ?? '');
      setRejectReason('');
    }
  }, [open, item]);

  if (!item) return null;

  const handleApprove = async () => {
    setBusy('approve');
    try {
      const updated = await emailIntelligenceService.approve(item._id, item.shouldDraft ? draft : undefined);
      toast.success(updated.shouldDraft ? 'Approved — click Send Reply to actually send it.' : 'Approved');
      onUpdated(updated);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy('reject');
    try {
      const updated = await emailIntelligenceService.reject(item._id, rejectReason || undefined);
      toast.success('Rejected');
      onUpdated(updated);
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRegenerate = async () => {
    setBusy('regenerate');
    try {
      const updated = await emailIntelligenceService.regenerate(item._id);
      toast.success('Regenerated');
      onUpdated(updated);
      setDraft(updated.draftReply ?? '');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // The deliberate second, explicit safety step — approving a draft never
  // sends it by itself (see Phase 14d plan notes). window.confirm is a
  // cheap but real extra checkpoint before a real, un-undoable email goes
  // out to a real customer.
  const handleSend = async () => {
    if (!window.confirm(`Send this reply to ${item.fromAddress}? This cannot be undone.`)) return;
    setBusy('send');
    try {
      const updated = await emailIntelligenceService.send(item._id);
      toast.success('Reply sent.');
      onUpdated(updated);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      // The backend records sendError on the item even though this call
      // throws — refetch so the modal's inline error banner reflects it,
      // not just the transient toast.
      try {
        onUpdated(await emailIntelligenceService.getOne(item._id));
      } catch {
        // Best-effort — the toast above already told the user it failed.
      }
    } finally {
      setBusy(null);
    }
  };

  const isApproved = item.status === 'approved';
  const isSent = !!item.sentAt;

  return (
    <Modal open={open} onClose={onClose} title={item.subject || '(no subject)'} maxWidth={640}>
      <div className={styles.formGrid}>
        <div className={styles.badgeRow}>
          <Badge variant="accent">{item.intent.replace(/_/g, ' ')}</Badge>
          <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority} priority</Badge>
          {(item.urgency === 'urgent' || item.urgency === 'high') && (
            <Badge variant={URGENCY_VARIANT[item.urgency]}>{URGENCY_LABEL[item.urgency]}</Badge>
          )}
          {item.sentiment !== 'neutral' && <Badge variant={SENTIMENT_VARIANT[item.sentiment] ?? 'neutral'}>{item.sentiment}</Badge>}
        </div>

        <div className={styles.card}>
          <div className={styles.fieldLabel}>Original Message</div>
          <div>From: {item.fromAddress}</div>
          <div>To: {item.toAddresses.join(', ') || '—'}</div>
          <div>Received: {new Date(item.receivedAt).toLocaleString()}</div>
          <div style={{ marginTop: 'var(--space-2)' }}>{item.bodyPreview}</div>
        </div>

        {item.matchedBusinessName && (
          <div className={styles.card}>
            <div className={styles.fieldLabel}>
              Matched Business: {item.matchedBusinessName}{' '}
              <Badge variant={item.matchConfidence === 'exact' ? 'success' : item.matchConfidence === 'domain' ? 'info' : 'warning'}>
                {item.matchConfidence}
              </Badge>
            </div>
            {item.matchedBusinessSummary && (
              <>
                <div className={styles.listItemMeta}>
                  {item.matchedBusinessSummary.openDealCount} open deal(s), {item.matchedBusinessSummary.wonDealCount} won
                </div>
                {item.matchedBusinessSummary.previousQuotes.length > 0 && (
                  <div className={styles.formGrid} style={{ marginTop: 'var(--space-2)' }}>
                    {item.matchedBusinessSummary.previousQuotes.map((q, i) => (
                      <div key={i} className={styles.quoteRow}>
                        <span>{q.quoteNumber ? `Quote #${q.quoteNumber}` : q.quoteName ?? 'Untitled quote'}</span>
                        <span>
                          {q.quoteAmount} {q.currency} · {q.quoteStatus}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {item.aiStatus && (
          <div className={styles.card}>
            <div className={styles.fieldLabel}>
              <FiShield style={{ verticalAlign: 'middle', marginRight: 4 }} />
              AI Decision
            </div>
            <div className={styles.formGrid}>
              <span>
                From: <strong>{item.fromRole ? FROM_ROLE_LABEL[item.fromRole] : '—'}</strong>
              </span>
              <span>
                Expected Next Action: <strong>{item.expectedNextAction ? NEXT_ACTION_LABEL[item.expectedNextAction] : '—'}</strong>
              </span>
              <span>
                AI Status: <Badge variant={AI_STATUS_VARIANT[item.aiStatus]}>{AI_STATUS_LABEL[item.aiStatus]}</Badge>
              </span>
              {item.reason && <span className={styles.listItemMeta}>Reason: {item.reason}</span>}
            </div>
          </div>
        )}

        <div className={styles.aiInsightCard}>
          <div className={styles.fieldLabel}>
            <FiZap style={{ verticalAlign: 'middle', marginRight: 4 }} />
            AI Recommendation
          </div>
          <div>{item.recommendedAction}</div>
          {item.draftReasoning && <div className={styles.listItemMeta}>{item.draftReasoning}</div>}
        </div>

        {item.shouldDraft && (
          <div>
            <div className={styles.fieldLabel}>Draft Reply {item.wasEdited && <Badge variant="accent">Edited</Badge>}</div>
            <textarea className={styles.textarea} value={draft} disabled={isApproved} onChange={(e) => setDraft(e.target.value)} />
          </div>
        )}

        {isSent && (
          <div className={styles.card}>
            <Badge variant="success">Sent</Badge>
            <span className={styles.listItemMeta}>Sent at {new Date(item.sentAt!).toLocaleString()}</span>
          </div>
        )}

        {item.sendError && !isSent && (
          <div className={styles.card}>
            <Badge variant="danger">Send failed</Badge>
            <span>{item.sendError}</span>
          </div>
        )}

        {!isApproved && item.status === 'pending' && (
          <Input label="Rejection reason (optional)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        )}

        <div className={styles.footer}>
          {!isApproved && (
            <Button type="button" variant="outline" disabled={busy !== null} loading={busy === 'regenerate'} onClick={() => void handleRegenerate()}>
              Regenerate
            </Button>
          )}
          {!isApproved && (
            <Button type="button" variant="danger" disabled={busy !== null} loading={busy === 'reject'} onClick={() => void handleReject()}>
              Reject
            </Button>
          )}
          {!isApproved && (
            <Button type="button" disabled={busy !== null} loading={busy === 'approve'} onClick={() => void handleApprove()}>
              Approve
            </Button>
          )}
          {isApproved && item.shouldDraft && !isSent && (
            <Button type="button" disabled={busy !== null} loading={busy === 'send'} onClick={() => void handleSend()}>
              Send Reply
            </Button>
          )}
          {isApproved && !item.shouldDraft && <Button type="button" disabled>Approved — no reply needed</Button>}
        </div>
      </div>
    </Modal>
  );
}
