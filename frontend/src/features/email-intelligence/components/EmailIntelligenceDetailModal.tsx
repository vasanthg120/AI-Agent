import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiCheckCircle, FiClock, FiCpu, FiMinusCircle, FiSend, FiZap } from 'react-icons/fi';
import clsx from 'clsx';
import { Avatar, Badge, Button, Input, Modal } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { emailIntelligenceService, type EmailIntelligenceItem } from '@/services/emailIntelligenceService';
import { formatWhen, RESPONDED_VIA_LABEL } from '../emailResponseLabels';
import { EmailThreadTimeline } from './EmailThreadTimeline';
import styles from '../email-intelligence.module.css';

// Same priority/urgency distinction as EmailIntelligenceList.tsx's own badges
// (kept in sync — see that file's comment for why the wording deliberately
// differs between the two axes).
const PRIORITY_VARIANT: Record<string, BadgeVariant> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};
const URGENCY_LABEL: Record<string, string> = { urgent: 'Reply today', high: 'Reply soon' };
const URGENCY_VARIANT: Record<string, BadgeVariant> = { urgent: 'danger', high: 'warning' };
const SENTIMENT_VARIANT: Record<string, BadgeVariant> = {
  negative: 'danger',
  frustrated: 'danger',
  positive: 'success',
  neutral: 'neutral',
};

type Busy = 'send' | 'approve' | 'draft' | 'close' | null;

// One clear sentence about where this email stands, driven by the backend's
// derived state — including an email answered in Outlook, an approved reply
// that has not gone out, and one whose send failed.
function ResponseBanner({ item }: { item: EmailIntelligenceItem }) {
  if (item.responseStatus === 'responded') {
    const via = item.respondedVia ? RESPONDED_VIA_LABEL[item.respondedVia] : 'Replied';
    const detail =
      item.respondedVia === 'outlook'
        ? 'A reply to this conversation was found in your Outlook Sent Items.'
        : item.respondedVia === 'thread'
          ? 'A later reply in this conversation answered it.'
          : 'Your reply was sent from here.';
    return (
      <div className={clsx(styles.banner, styles.bannerDone)} role="status">
        <FiCheckCircle aria-hidden />
        <div>
          <strong>{via}</strong>
          {item.respondedAt ? ` · ${formatWhen(item.respondedAt)}` : ''}
          <div className={styles.listItemMeta}>{detail}</div>
        </div>
      </div>
    );
  }
  if (item.responseStatus === 'needs_response') {
    if (item.sendError) {
      return (
        <div className={clsx(styles.banner, styles.bannerFailed)} role="alert">
          <FiAlertTriangle aria-hidden />
          <div>
            <strong>The reply was not sent</strong>
            <div className={styles.listItemMeta}>
              {item.sendError.replace(/[\s.]+$/, '')}. Nothing has gone out — you can send it again.
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={clsx(styles.banner, styles.bannerWaiting)} role="status">
        <FiClock aria-hidden />
        <div>
          <strong>Waiting for your reply</strong>
          <div className={styles.listItemMeta}>
            {item.status === 'approved'
              ? 'The reply is approved but has not been sent yet.'
              : 'Nothing has been sent to this customer yet.'}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={clsx(styles.banner, styles.bannerClosed)} role="status">
      <FiMinusCircle aria-hidden />
      <div>
        <strong>No reply needed</strong>
        <div className={styles.listItemMeta}>
          {item.status === 'rejected'
            ? 'You closed this one without replying.'
            : 'Nothing is owed on this email. You can still reply if you want to.'}
        </div>
      </div>
    </div>
  );
}

// One email, and the reply to it. Read top to bottom: where it stands, what
// the customer wrote, what the AI makes of it, your reply — then one button.
//
// "Approve & send" really is one step: the reply in the box — the AI's draft,
// your edit of it, or your own words — is approved and sent. (With "Send when
// I approve" switched off, approving only saves it and sending is separate.)
export function EmailIntelligenceDetailModal({
  open,
  item,
  sendOnApprove = true,
  onClose,
  onUpdated,
}: {
  open: boolean;
  item: EmailIntelligenceItem | null;
  // The mailbox owner's setting: does approving a reply also send it.
  sendOnApprove?: boolean;
  onClose: () => void;
  onUpdated: (item: EmailIntelligenceItem) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  // "No reply needed" asks once, in place, before closing the email.
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  // An email nobody owes a reply to can still be answered — on request.
  const [replyAnyway, setReplyAnyway] = useState(false);

  // A different email: start from its own reply. (Keyed on the id, so an
  // update to the same email — a fresh draft, a failed send — keeps what is typed.)
  useEffect(() => {
    if (!open || !item) return;
    setDraft(item.finalDraftReply ?? item.draftReply ?? '');
    setClosing(false);
    setCloseReason('');
    setReplyAnyway(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?._id]);

  if (!item) return null;

  const isSent = !!item.sentAt;
  const isResponded = item.responseStatus === 'responded';
  const isClosed = item.responseStatus === 'resolved';
  const isApproved = item.status === 'approved';
  const hasAiDraft = !!item.draftReply?.trim();
  const notReadByAi = item.aiRead === false || item.analysisState === 'pending';
  const canReply = !isResponded && (!isClosed || replyAnyway);
  const text = draft.trim();
  const sender = item.fromName || item.fromAddress;

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
      // The backend records what went wrong on the email itself (a failed
      // send, for one) — show that, not just the passing message.
      try {
        onUpdated(await emailIntelligenceService.getOne(item._id));
      } catch {
        // Best-effort: the message above already said it failed.
      }
    } finally {
      setBusy(null);
    }
  };

  const approveAndSend = () =>
    run('send', async () => {
      const updated = await emailIntelligenceService.reply(item._id, text);
      toast.success(`Reply sent to ${sender}.`);
      onUpdated(updated);
      onClose();
    });

  const approveOnly = () =>
    run('approve', async () => {
      const updated = await emailIntelligenceService.approve(item._id, text);
      toast.success('Reply approved — press Send reply when you’re ready. Nothing has been sent yet.');
      onUpdated(updated);
    });

  // The second, explicit step for people who chose to keep approving and sending apart.
  const sendApproved = () => {
    if (!window.confirm(`Send this reply to ${item.fromAddress}? This cannot be undone.`)) return;
    void run('send', async () => {
      // Sends what is in the box: an edit made after approving is not lost.
      const updated = await emailIntelligenceService.reply(item._id, text);
      toast.success(`Reply sent to ${sender}.`);
      onUpdated(updated);
      onClose();
    });
  };

  const draftWithAi = () =>
    run('draft', async () => {
      const updated = await emailIntelligenceService.regenerate(item._id);
      onUpdated(updated);
      if (updated.draftReply?.trim()) {
        setDraft(updated.draftReply);
        toast.success(
          hasAiDraft ? 'New draft written — check it before sending.' : 'Draft written — check it before sending.',
        );
      } else if (updated.responseStatus === 'resolved') {
        toast('The AI read this email and thinks no reply is needed. You can still write one.', { duration: 7_000 });
      } else {
        toast('The AI read this email but could not draft a reply — write this one yourself.', { duration: 7_000 });
      }
    });

  const closeWithoutReply = () =>
    run('close', async () => {
      const updated = await emailIntelligenceService.reject(item._id, closeReason.trim() || undefined);
      toast.success('Closed — no reply will be sent.');
      onUpdated(updated);
      onClose();
    });

  return (
    <Modal open={open} onClose={onClose} title={item.subject || '(no subject)'} maxWidth={680}>
      <div className={styles.detail}>
        <ResponseBanner item={item} />

        {/* 1 — what the customer wrote */}
        <section className={styles.detailSection}>
          <div className={styles.senderRow}>
            <Avatar name={sender} size="sm" />
            <div className={styles.senderText}>
              <strong>{sender}</strong>
              <span className={styles.listItemMeta}>
                {item.fromName ? `${item.fromAddress} · ` : ''}
                {formatWhen(item.receivedAt)}
                {item.matchedBusinessName ? ` · ${item.matchedBusinessName}` : ''}
              </span>
            </div>
            <div className={styles.badgeRow}>
              {!notReadByAi && <Badge variant="accent">{item.intent.replace(/_/g, ' ')}</Badge>}
              {item.urgency === 'urgent' || item.urgency === 'high' ? (
                <Badge variant={URGENCY_VARIANT[item.urgency]}>{URGENCY_LABEL[item.urgency]}</Badge>
              ) : (
                !notReadByAi && <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority} priority</Badge>
              )}
              {item.sentiment !== 'neutral' && (
                <Badge variant={SENTIMENT_VARIANT[item.sentiment] ?? 'neutral'}>{item.sentiment}</Badge>
              )}
            </div>
          </div>
          {item.bodyPreview && <p className={styles.customerMessage}>{item.bodyPreview}</p>}
        </section>

        <EmailThreadTimeline itemId={item._id} />

        {item.matchedBusinessName &&
          item.matchedBusinessSummary &&
          (item.matchedBusinessSummary.openDealCount > 0 ||
            item.matchedBusinessSummary.wonDealCount > 0 ||
            item.matchedBusinessSummary.previousQuotes.length > 0) && (
            <div className={styles.card}>
              <div className={styles.fieldLabel}>
                In your CRM: {item.matchedBusinessName}{' '}
                <Badge
                  variant={
                    item.matchConfidence === 'exact'
                      ? 'success'
                      : item.matchConfidence === 'domain'
                        ? 'info'
                        : 'warning'
                  }
                >
                  {item.matchConfidence} match
                </Badge>
              </div>
              <div className={styles.listItemMeta}>
                {item.matchedBusinessSummary.openDealCount} open deal(s), {item.matchedBusinessSummary.wonDealCount} won
              </div>
              {item.matchedBusinessSummary.previousQuotes.length > 0 && (
                <div className={styles.formGrid} style={{ marginTop: 'var(--space-2)' }}>
                  {item.matchedBusinessSummary.previousQuotes.map((q, i) => (
                    <div key={i} className={styles.quoteRow}>
                      <span>{q.quoteNumber ? `Quote #${q.quoteNumber}` : (q.quoteName ?? 'Untitled quote')}</span>
                      <span>
                        {q.quoteAmount} {q.currency} · {q.quoteStatus}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        {/* 2 — what the AI makes of it, in plain words */}
        {!notReadByAi && (
          <div className={styles.aiInsightCard}>
            <div className={styles.fieldLabel}>
              <FiZap aria-hidden style={{ verticalAlign: 'middle', marginRight: 4 }} />
              What the AI suggests{' '}
              {item.aiStatus === 'validation_failed' && <Badge variant="danger">Write this one yourself</Badge>}
            </div>
            <div>{item.recommendedAction}</div>
            {/* The AI's reasoning is there for anyone who wants it, not in the way of everyone else. */}
            {(item.draftReasoning || item.reason) &&
              (item.draftReasoning || item.reason) !== item.recommendedAction && (
                <details className={styles.followUpDetails}>
                  <summary>Why the AI suggests this</summary>
                  <div>{item.draftReasoning || item.reason}</div>
                </details>
              )}
          </div>
        )}

        {/* 3 — the reply */}
        {isSent && (
          <section className={styles.detailSection}>
            <div className={styles.replyHead}>
              <span className={styles.fieldLabel}>Your reply</span>
              {item.wasEdited && <Badge variant="accent">Edited before sending</Badge>}
            </div>
            <p className={styles.sentReply}>{item.finalDraftReply}</p>
          </section>
        )}

        {isClosed && !replyAnyway && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<FiSend />}
              onClick={() => setReplyAnyway(true)}
            >
              Reply anyway
            </Button>
          </div>
        )}

        {canReply && (
          <section className={styles.detailSection}>
            <div className={styles.replyHead}>
              <label className={styles.fieldLabel} htmlFor="email-reply-text">
                Your reply
              </label>
              {hasAiDraft && text === item.draftReply?.trim() && <Badge variant="accent">Written by AI</Badge>}
              {hasAiDraft && text !== '' && text !== item.draftReply?.trim() && <Badge variant="neutral">Edited</Badge>}
              <Button
                type="button"
                variant="outline"
                size="sm"
                leftIcon={<FiCpu />}
                disabled={busy !== null}
                loading={busy === 'draft'}
                onClick={() => void draftWithAi()}
              >
                {hasAiDraft ? 'Rewrite with AI' : 'Draft with AI'}
              </Button>
            </div>
            <textarea
              id="email-reply-text"
              className={styles.textarea}
              value={draft}
              disabled={busy === 'send' || busy === 'draft'}
              placeholder={
                notReadByAi
                  ? 'Write your reply here — or press “Draft with AI” and the AI will write one for you to check.'
                  : 'Write your reply here.'
              }
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className={styles.replyHint}>
              Goes to <strong>{item.fromAddress}</strong> from <strong>{item.mailboxEmail}</strong>, as a reply in the
              same conversation.
            </p>
          </section>
        )}

        {closing && (
          <div className={styles.closeBox}>
            <Input
              label="Why no reply? (optional)"
              value={closeReason}
              placeholder="e.g. spam, already handled by phone"
              onChange={(e) => setCloseReason(e.target.value)}
            />
            <div className={styles.footer}>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setClosing(false)}>
                Keep it open
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={busy === 'close'}
                disabled={busy !== null}
                onClick={() => void closeWithoutReply()}
              >
                Close without replying
              </Button>
            </div>
          </div>
        )}

        {/* The actions stay in reach however long the email is. */}
        {!closing && (
          <div className={styles.detailFooter}>
            {canReply && !isClosed && (
              <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setClosing(true)}>
                No reply needed
              </Button>
            )}
            <span className={styles.footerSpacer} />
            {!canReply && (
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            )}
            {canReply && sendOnApprove && (
              <Button
                type="button"
                leftIcon={<FiSend />}
                disabled={busy !== null || text === ''}
                loading={busy === 'send'}
                title={text === '' ? 'Write the reply first, or let the AI draft one' : undefined}
                onClick={() => void approveAndSend()}
              >
                {item.sendError ? 'Send again' : 'Approve & send'}
              </Button>
            )}
            {canReply && !sendOnApprove && !isApproved && (
              <Button
                type="button"
                disabled={busy !== null || text === ''}
                loading={busy === 'approve'}
                onClick={() => void approveOnly()}
              >
                Approve
              </Button>
            )}
            {canReply && !sendOnApprove && isApproved && (
              <Button
                type="button"
                leftIcon={<FiSend />}
                disabled={busy !== null || text === ''}
                loading={busy === 'send'}
                onClick={sendApproved}
              >
                {item.sendError ? 'Send again' : 'Send reply'}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
