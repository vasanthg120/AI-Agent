import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle } from 'react-icons/fi';
import { Badge, Button, Modal, Skeleton } from '@/components/ui';
import { emailIntelligenceService, type EmailFollowUpReminder } from '@/services/emailIntelligenceService';
import { integrationsService } from '@/services/integrationsService';
import { extractErrorMessage } from '@/utils/errors';
import { AiFollowUpDrawer } from './AiFollowUpDrawer';
import styles from '../email-intelligence.module.css';

const DRAFT_STATUS_BADGE: Record<
  EmailFollowUpReminder['draftStatus'],
  { label: string; variant: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }
> = {
  none: { label: 'No draft', variant: 'neutral' },
  generating: { label: 'Generating…', variant: 'accent' },
  pending_review: { label: 'Draft ready', variant: 'warning' },
  approved: { label: 'Approved', variant: 'accent' },
  sent: { label: 'Sent', variant: 'success' },
  failed: { label: 'Draft failed', variant: 'danger' },
};

// Follow-ups are created automatically as a side effect of Phase 14e's
// runPostSendActions() — a reminder to check back with a customer 3 days
// after a reply is actually SENT (not just approved). This means the empty
// state has three genuinely different real causes, and each needs different
// user action — never worth collapsing into one generic "no data" message.
export function FollowUpsSection() {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<EmailFollowUpReminder | null>(null);
  const [draftText, setDraftText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // AI Follow-up Agent (SLA-breach trigger) reminders get the richer review
  // drawer (customer email, context indicators, dismiss/regenerate/send);
  // the existing 'post_reply' reminders keep using the plain textarea Modal
  // below, completely unchanged.
  const [aiFollowUpReviewing, setAiFollowUpReviewing] = useState<EmailFollowUpReminder | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['email-intelligence-follow-ups'],
    queryFn: () => emailIntelligenceService.getFollowUps(),
    refetchInterval: 60_000,
  });
  const { data: outlookStatus } = useQuery({
    queryKey: ['outlook-status-for-followups'],
    queryFn: () => integrationsService.getOutlookStatus(),
    staleTime: 60_000,
  });

  // The rows above (who is due a follow-up) read the same reminders: a draft written, approved or
  // sent here must show there too, or they would offer to draft the same follow-up twice.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-ups'] }),
      queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-up-analysis'] }),
    ]);

  // Every action says what happened: a failure is shown, never just a button that stops spinning.
  const run = async (reminderId: string, action: () => Promise<void>) => {
    setBusyId(reminderId);
    try {
      await action();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusyId(null);
    }
  };

  const handleGenerateDraft = (reminder: EmailFollowUpReminder) =>
    run(reminder._id, async () => {
      const updated = await emailIntelligenceService.generateFollowUpDraft(reminder._id);
      await invalidate();
      if (updated.draftStatus === 'pending_review') {
        // Straight into review: nothing is sent until it is approved and sent by hand.
        setDraftText(updated.draftReply ?? '');
        setReviewing(updated);
      } else {
        toast.error('The draft couldn’t be written. Try again in a minute.');
      }
    });

  const handleApprove = () => {
    if (!reviewing) return;
    if (!draftText.trim()) {
      toast.error('The draft is empty — write the message before approving it.');
      return;
    }
    return run(reviewing._id, async () => {
      await emailIntelligenceService.approveFollowUpDraft(reviewing._id, draftText);
      await invalidate();
      setReviewing(null);
      toast.success('Draft approved — press Send when you’re ready. Nothing has been sent yet.');
    });
  };

  const handleSend = (reminder: EmailFollowUpReminder) => {
    if (!window.confirm('Send this follow-up to the customer now? This cannot be undone.')) return;
    return run(reminder._id, async () => {
      await emailIntelligenceService.sendFollowUp(reminder._id);
      await invalidate();
      toast.success('Follow-up sent.');
    });
  };

  const handleDone = (reminder: EmailFollowUpReminder) =>
    run(reminder._id, async () => {
      await emailIntelligenceService.markFollowUpDone(reminder._id);
      await invalidate();
    });

  if (isLoading || !data) return <Skeleton height={80} />;

  if (data.length === 0) {
    let message =
      'No pending follow-ups. Follow-ups are created automatically 3 days after you send a reply to a customer.';
    if (outlookStatus && !outlookStatus.connected) {
      message =
        'No pending follow-ups yet — connect Outlook in Integrations to start sending replies and generating follow-ups.';
    } else if (outlookStatus && outlookStatus.connected && !outlookStatus.canSend) {
      message =
        "No pending follow-ups yet. Your connected Outlook account can't send email yet — reconnect it in Integrations to grant permission to send, then follow-ups will start appearing after you send a reply.";
    }
    return <div className={styles.emptyState}>{message}</div>;
  }

  return (
    <div className={styles.formGrid} id="follow-up-drafts">
      {data.map((reminder) => {
        const badge = DRAFT_STATUS_BADGE[reminder.draftStatus] ?? DRAFT_STATUS_BADGE.none;
        const isBusy = busyId === reminder._id;

        // AI Follow-up Agent (SLA-breach trigger) — a compact card that
        // opens the richer AiFollowUpDrawer, distinct from the plain
        // 'post_reply' reminders rendered below (same list, same query,
        // same actions data — just a different card for a different reason
        // the reminder exists).
        if (reminder.reminderType === 'sla_breach') {
          return (
            <div key={reminder._id} className={styles.listItem}>
              <div className={styles.listItemMain}>
                <span className={styles.listItemTitle}>{reminder.businessName ?? reminder.title}</span>
                <span className={styles.listItemMeta}>{reminder.title}</span>
              </div>
              <div className={styles.badgeRow}>
                <Badge variant="danger">
                  <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  SLA breached
                </Badge>
                <Badge variant={badge.variant}>{badge.label}</Badge>
                <Button variant="secondary" size="sm" onClick={() => setAiFollowUpReviewing(reminder)}>
                  Review draft
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div key={reminder._id} className={styles.listItem}>
            <div className={styles.listItemMain}>
              <span className={styles.listItemTitle}>{reminder.title}</span>
              <span className={styles.listItemMeta}>
                {reminder.businessName ? `${reminder.businessName} · ` : ''}
                Due {new Date(reminder.dueDate).toLocaleDateString()}
              </span>
            </div>
            <div className={styles.badgeRow}>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {reminder.draftStatus === 'none' || reminder.draftStatus === 'failed' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={isBusy}
                  onClick={() => void handleGenerateDraft(reminder)}
                >
                  {reminder.draftStatus === 'failed' ? 'Try again' : 'Generate Draft'}
                </Button>
              ) : null}
              {reminder.draftStatus === 'pending_review' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDraftText(reminder.draftReply ?? '');
                    setReviewing(reminder);
                  }}
                >
                  Review Draft
                </Button>
              ) : null}
              {reminder.draftStatus === 'approved' ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDraftText(reminder.draftReply ?? '');
                      setReviewing(reminder);
                    }}
                  >
                    Edit
                  </Button>
                  <Button variant="primary" size="sm" loading={isBusy} onClick={() => void handleSend(reminder)}>
                    Send
                  </Button>
                </>
              ) : null}
              {reminder.status === 'pending' ? (
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => void handleDone(reminder)}>
                  Mark Done
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}

      <Modal
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title="Review follow-up draft"
        description={reviewing?.businessName}
      >
        <label className={styles.fieldLabel} htmlFor="follow-up-draft-text">
          Draft reply
        </label>
        <textarea
          id="follow-up-draft-text"
          className={styles.textarea}
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
        />
        <div className={styles.footer}>
          <Button variant="secondary" onClick={() => setReviewing(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busyId === reviewing?._id} onClick={() => void handleApprove()}>
            Approve
          </Button>
        </div>
      </Modal>

      <AiFollowUpDrawer reminder={aiFollowUpReviewing} onClose={() => setAiFollowUpReviewing(null)} />
    </div>
  );
}
