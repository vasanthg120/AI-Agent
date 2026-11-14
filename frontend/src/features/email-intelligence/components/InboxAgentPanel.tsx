import clsx from 'clsx';
import { FiAlertTriangle, FiCheckCircle, FiCpu, FiEdit3, FiEye, FiInbox, FiRefreshCw, FiZap } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { dayjs } from '@/utils/date';
import type { EmailDraftSummary, EmailInboxCounts, EmailSyncState, InboxBox } from '@/services/emailIntelligenceService';
import styles from './InboxAgentPanel.module.css';

const n = (value: number | undefined) => (value ?? 0).toLocaleString();

// The inbox agent at a glance: is it reading the mailbox (and if not, why, in
// words — a sync that kept failing used to look like an empty inbox), and what
// it has done with the mail — sorted it, drafted replies, spotted answers and
// watched for follow-ups. What needs a reply is the queue cards' job, just below.
export function InboxAgentPanel({
  syncState,
  counts,
  drafts,
  followUpsDue,
  onOpenBox,
  onFollowUps,
  onRetry,
  retrying,
}: {
  syncState?: EmailSyncState;
  counts?: EmailInboxCounts;
  drafts?: EmailDraftSummary;
  followUpsDue: number;
  onOpenBox: (box: InboxBox) => void;
  onFollowUps: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const health = syncState?.health;
  const failing = health?.status === 'failing';
  const lastRead = syncState?.lastSyncedAt ?? health?.lastSuccessAt;
  const boxes = counts?.boxes;
  const total = boxes ? Object.values(boxes).reduce((sum, n) => sum + n, 0) : 0;
  const junk = boxes?.junk ?? 0;
  const answered = (boxes?.replied ?? 0) + (boxes?.awaiting_customer ?? 0);

  return (
    <section className={styles.panel} aria-label="Inbox agent">
      <div className={styles.head}>
        <span className={styles.title}>
          <FiCpu aria-hidden /> Inbox agent
        </span>
        {failing ? (
          <span className={clsx(styles.pill, styles.pillBad)}>
            <FiAlertTriangle aria-hidden /> Can’t read your mailbox
          </span>
        ) : health?.status === 'never_synced' ? (
          <span className={styles.pill}>Waiting for its first read of your mailbox</span>
        ) : (
          <span className={clsx(styles.pill, styles.pillOk)}>
            <span className={styles.dot} aria-hidden /> {syncState?.running ? 'Reading your mailbox now' : 'Working'}
            {lastRead && !syncState?.running ? ` · last read ${dayjs(lastRead).format('D MMM, h:mm A')}` : ''}
          </span>
        )}
      </div>

      {failing && (
        <div className={styles.alert} role="alert">
          <div className={styles.alertText}>
            <strong>{health?.reason}</strong>
            <span>
              {health?.lastSuccessAt ? `Last read ${dayjs(health.lastSuccessAt).format('D MMM, h:mm A')}` : 'Never read yet'}
              {health?.failedRuns ? ` · ${health.failedRuns} ${health.failedRuns === 1 ? 'try has' : 'tries have'} failed since` : ''}. Until it
              works, new mail won’t arrive here and replies sent from Outlook can’t be spotted — use <em>I already replied</em> on emails you’ve
              answered.
            </span>
          </div>
          <Button type="button" size="sm" variant="secondary" leftIcon={<FiRefreshCw />} loading={retrying} onClick={onRetry}>
            Try again now
          </Button>
        </div>
      )}

      <div className={styles.steps}>
        <div className={styles.step}>
          <span className={styles.stepIcon} aria-hidden>
            <FiInbox />
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepLabel}>Reads & sorts your mail</span>
            <span className={styles.stepValue}>{n(total)} sorted</span>
            <span className={styles.stepSub}>
              {(syncState?.awaitingAnalysis ?? 0) > 0
                ? `${n(syncState?.awaitingAnalysis)} still to be read by the AI`
                : junk > 0
                  ? `${n(junk)} junk & automated set aside`
                  : 'By what each one needs from you'}
            </span>
          </span>
        </div>

        <div className={styles.step}>
          <span className={styles.stepIcon} aria-hidden>
            <FiEdit3 />
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepLabel}>Drafts replies</span>
            <span className={styles.stepValue}>{n(drafts?.withDraft)} ready</span>
            <span className={styles.stepSub}>
              {drafts?.running
                ? 'Writing drafts now…'
                : drafts?.settings.autoDraft
                  ? 'Drafts new mail on its own'
                  : `${n(drafts?.withoutDraft)} without a draft · auto-draft off`}
            </span>
          </span>
        </div>

        <button type="button" className={clsx(styles.step, styles.stepButton)} onClick={() => onOpenBox('replied')}>
          <span className={styles.stepIcon} aria-hidden>
            <FiCheckCircle />
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepLabel}>Spots your replies</span>
            <span className={styles.stepValue}>{n(answered)} answered</span>
            <span className={styles.stepSub}>{failing ? 'Paused — mailbox can’t be read' : 'Here, in Outlook, or in the thread'}</span>
          </span>
        </button>

        <button type="button" className={clsx(styles.step, styles.stepButton, followUpsDue > 0 && styles.stepAttention)} onClick={onFollowUps}>
          <span className={styles.stepIcon} aria-hidden>
            {followUpsDue > 0 ? <FiZap /> : <FiEye />}
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepLabel}>Watches follow-ups</span>
            <span className={styles.stepValue}>{n(followUpsDue)} due</span>
            <span className={styles.stepSub}>Customers who went quiet after your reply</span>
          </span>
        </button>
      </div>
    </section>
  );
}
