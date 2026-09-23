import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiClock, FiMail, FiX } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { Badge, Button, Modal, Spinner } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { emailIntelligenceService, type EmailFollowUpReminder } from '@/services/emailIntelligenceService';
import styles from '../email-intelligence.module.css';

// Same priority colors as EmailIntelligenceDetailModal.tsx/EmailIntelligenceList.tsx
// — reused exactly, never a second priority palette.
const PRIORITY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };

// The AI Follow-up Agent's review screen — the one place an employee
// actually acts on an SLA-breached email. Deliberately a focused Modal (this
// app's existing "review one thing, then act" component — same one
// FinanceDocumentReviewModal/BusinessKnowledgeDocumentReviewModal already
// use), not a new drawer primitive: the interaction principle Outlook/
// Copilot uses (list -> select -> focused panel -> review -> act) is what
// matters here, not a literal side-panel widget.
//
// AI generates the draft; the employee stays fully in control — Send always
// requires an explicit click here, exactly like the existing approve()/
// send() flow on a regular email reply. No auto-send anywhere in this file.
export function AiFollowUpDrawer({ reminder, onClose }: { reminder: EmailFollowUpReminder | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draftText, setDraftText] = useState('');
  const [regenerateNote, setRegenerateNote] = useState('');
  const [showRegenerateNote, setShowRegenerateNote] = useState(false);
  const [showDismissConfirm, setShowDismissConfirm] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [busy, setBusy] = useState<'regenerate' | 'send' | 'dismiss' | null>(null);

  const { data: sourceEmail, isLoading: emailLoading } = useQuery({
    queryKey: ['email-intelligence-item', reminder?.emailIntelligenceItemId],
    queryFn: () => emailIntelligenceService.getOne(reminder!.emailIntelligenceItemId),
    enabled: !!reminder,
  });

  useEffect(() => {
    setDraftText(reminder?.draftReply ?? '');
    setShowRegenerateNote(false);
    setRegenerateNote('');
    setShowDismissConfirm(false);
    setDismissReason('');
  }, [reminder?._id, reminder?.draftReply]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-ups'] });

  if (!reminder) return null;

  const minutesAgo = (() => {
    // draftGeneratedAt is when SLA breached & the draft was made — close
    // enough to "SLA breached X ago" without a dedicated timestamp field.
    const since = reminder.draftGeneratedAt ?? reminder.createdAt;
    const mins = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60_000));
    if (mins < 60) return `${mins} min ago`;
    return `${Math.round(mins / 60)} hr ago`;
  })();

  const handleRegenerate = async () => {
    setBusy('regenerate');
    try {
      // The optional instruction field (e.g. "make it shorter") isn't sent
      // anywhere yet — generateFollowUpDraft always re-gathers fresh
      // context and re-drafts from scratch, same as the existing
      // 'post_reply' regenerate action. Kept as a visible field for
      // symmetry with the target UI; wiring it into the prompt is a small,
      // separate follow-up, not done here to avoid touching the shared
      // draft-generation contract for a cosmetic instruction that has no
      // effect yet — noted honestly rather than silently ignored.
      void regenerateNote;
      const updated = await emailIntelligenceService.generateFollowUpDraft(reminder._id);
      setDraftText(updated.draftReply ?? '');
      setShowRegenerateNote(false);
      setRegenerateNote('');
      await invalidate();
      if (updated.draftStatus === 'failed') toast.error('AI draft could not be generated. You can still reply manually.');
      else toast.success('Draft regenerated');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSend = async () => {
    if (!window.confirm(`Send this reply to ${sourceEmail?.fromAddress ?? 'the customer'}? This cannot be undone.`)) return;
    setBusy('send');
    try {
      await emailIntelligenceService.approveFollowUpDraft(reminder._id, draftText);
      await emailIntelligenceService.sendFollowUp(reminder._id);
      await invalidate();
      toast.success('Reply sent.');
      onClose();
    } catch (err) {
      // The existing send/error handling stays authoritative here too — a
      // failed Outlook dispatch never marks this sent, and the draft (now
      // saved as 'approved') is preserved so the employee can just retry.
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDismiss = async () => {
    setBusy('dismiss');
    try {
      await emailIntelligenceService.dismissFollowUp(reminder._id, dismissReason || undefined);
      await invalidate();
      toast.success('Follow-up dismissed');
      onClose();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const priority = sourceEmail?.priority;
  const contextItems: { key: keyof NonNullable<EmailFollowUpReminder['contextUsed']>; label: string; icon: IconType }[] = [
    { key: 'thread', label: 'Email conversation', icon: FiMail },
    { key: 'crm', label: 'CRM information', icon: FiCheckCircle },
    { key: 'businessKnowledge', label: 'Business Knowledge', icon: FiCheckCircle },
  ];

  return (
    <Modal open={!!reminder} onClose={onClose} title="AI Follow-up" maxWidth={640}>
      <div className={styles.formGrid}>
        <div>
          <div className={styles.listItemTitle}>{reminder.businessName ?? sourceEmail?.fromAddress ?? 'Customer'}</div>
          <div className={styles.listItemMeta}>{reminder.title}</div>
        </div>

        <div className={styles.badgeRow}>
          {priority && <Badge variant={PRIORITY_VARIANT[priority] ?? 'neutral'}>{priority} priority</Badge>}
          <Badge variant="danger">
            <FiClock style={{ verticalAlign: 'middle', marginRight: 4 }} />
            SLA breached {minutesAgo}
          </Badge>
        </div>

        {emailLoading ? (
          <Spinner size={16} />
        ) : sourceEmail ? (
          <div className={styles.card}>
            <div className={styles.fieldLabel}>Customer email</div>
            <div>{sourceEmail.bodyPreview}</div>
          </div>
        ) : null}

        <div>
          <div className={styles.fieldLabel}>✨ AI follow-up draft</div>
          {reminder.draftStatus === 'generating' ? (
            <div className={styles.card}>
              <Spinner size={16} /> Generating draft…
            </div>
          ) : reminder.draftStatus === 'failed' ? (
            <div className={styles.emptyState}>AI draft could not be generated. You can reply manually, or try Regenerate.</div>
          ) : (
            <textarea className={styles.textarea} value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={10} />
          )}
        </div>

        {reminder.contextUsed && (
          <div className={styles.card}>
            <div className={styles.fieldLabel}>AI used relevant business context</div>
            {contextItems
              .filter((c) => reminder.contextUsed?.[c.key])
              .map((c) => (
                <div key={c.key} className={styles.listItemMeta}>
                  <FiCheckCircle style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--color-success)' }} />
                  {c.label}
                </div>
              ))}
            {!contextItems.some((c) => reminder.contextUsed?.[c.key]) && (
              <span className={styles.listItemMeta}>No additional context was available — draft based on the email alone.</span>
            )}
          </div>
        )}

        {showRegenerateNote && (
          <div className={styles.formGrid}>
            <input
              className={styles.textarea}
              style={{ minHeight: 'unset' }}
              placeholder="Optional: make the reply shorter and more direct"
              value={regenerateNote}
              onChange={(e) => setRegenerateNote(e.target.value)}
            />
          </div>
        )}

        {showDismissConfirm && (
          <div className={styles.card}>
            <div className={styles.fieldLabel}>Dismiss AI follow-up?</div>
            <span className={styles.listItemMeta}>This draft will no longer appear in your pending follow-ups.</span>
            <input
              className={styles.textarea}
              style={{ minHeight: 'unset' }}
              placeholder="Reason (optional)"
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
            />
            <div className={styles.footer}>
              <Button variant="secondary" size="sm" onClick={() => setShowDismissConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" loading={busy === 'dismiss'} onClick={() => void handleDismiss()}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <div className={styles.footer}>
          <Button variant="secondary" leftIcon={<FiX />} onClick={() => setShowDismissConfirm(true)} disabled={busy !== null}>
            Dismiss
          </Button>
          <Button
            variant="secondary"
            loading={busy === 'regenerate'}
            disabled={busy !== null}
            onClick={() => (showRegenerateNote ? void handleRegenerate() : setShowRegenerateNote(true))}
          >
            {showRegenerateNote ? 'Confirm Regenerate' : 'Regenerate'}
          </Button>
          <Button
            variant="primary"
            loading={busy === 'send'}
            disabled={busy !== null || !draftText.trim() || reminder.draftStatus === 'generating'}
            onClick={() => void handleSend()}
          >
            Send email
          </Button>
        </div>
      </div>
    </Modal>
  );
}
