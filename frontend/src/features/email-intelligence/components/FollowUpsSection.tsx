import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Modal, Skeleton } from '@/components/ui';
import { emailIntelligenceService, type EmailFollowUpReminder } from '@/services/emailIntelligenceService';
import { integrationsService } from '@/services/integrationsService';
import styles from '../email-intelligence.module.css';

const DRAFT_STATUS_BADGE: Record<EmailFollowUpReminder['draftStatus'], { label: string; variant: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-ups'] });

  const handleGenerateDraft = async (reminder: EmailFollowUpReminder) => {
    setBusyId(reminder._id);
    try {
      const updated = await emailIntelligenceService.generateFollowUpDraft(reminder._id);
      await invalidate();
      if (updated.draftStatus === 'pending_review') {
        setDraftText(updated.draftReply ?? '');
        setReviewing(updated);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleApprove = async () => {
    if (!reviewing) return;
    setBusyId(reviewing._id);
    try {
      await emailIntelligenceService.approveFollowUpDraft(reviewing._id, draftText);
      await invalidate();
      setReviewing(null);
    } finally {
      setBusyId(null);
    }
  };

  const handleSend = async (reminder: EmailFollowUpReminder) => {
    setBusyId(reminder._id);
    try {
      await emailIntelligenceService.sendFollowUp(reminder._id);
      await invalidate();
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading || !data) return <Skeleton height={80} />;

  if (data.length === 0) {
    let message = 'No pending follow-ups. Follow-ups are created automatically 3 days after you send a reply to a customer.';
    if (outlookStatus && !outlookStatus.connected) {
      message = 'No pending follow-ups yet — connect Outlook in Integrations to start sending replies and generating follow-ups.';
    } else if (outlookStatus && outlookStatus.connected && !outlookStatus.canSend) {
      message =
        'No pending follow-ups yet. Your connected Outlook account can\'t send email yet — reconnect it in Integrations to grant permission to send, then follow-ups will start appearing after you send a reply.';
    }
    return <div className={styles.emptyState}>{message}</div>;
  }

  return (
    <div className={styles.formGrid}>
      {data.map((reminder) => {
        const badge = DRAFT_STATUS_BADGE[reminder.draftStatus] ?? DRAFT_STATUS_BADGE.none;
        const isBusy = busyId === reminder._id;
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
                <Button variant="secondary" size="sm" loading={isBusy} onClick={() => handleGenerateDraft(reminder)}>
                  Generate Draft
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
                <Button variant="primary" size="sm" loading={isBusy} onClick={() => handleSend(reminder)}>
                  Send
                </Button>
              ) : null}
              {reminder.status === 'pending' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await emailIntelligenceService.markFollowUpDone(reminder._id);
                    void invalidate();
                  }}
                >
                  Mark Done
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}

      <Modal open={!!reviewing} onClose={() => setReviewing(null)} title="Review follow-up draft" description={reviewing?.businessName}>
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
          <Button variant="primary" loading={busyId === reviewing?._id} onClick={handleApprove}>
            Approve
          </Button>
        </div>
      </Modal>
    </div>
  );
}
