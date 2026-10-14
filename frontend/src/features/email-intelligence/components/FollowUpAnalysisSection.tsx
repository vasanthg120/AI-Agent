import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FiAlertTriangle, FiCheckCircle, FiClock, FiEdit3, FiMail } from 'react-icons/fi';
import {
  Badge,
  Button,
  ChoiceCards,
  EmptyState,
  Skeleton,
  type BadgeVariant,
  type ChoiceCardItem,
} from '@/components/ui';
import { emailIntelligenceService, type FollowUpBucket, type FollowUpRow } from '@/services/emailIntelligenceService';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../email-intelligence.module.css';

// Emails nobody has answered are the Inbox tab's Needs Response queue — not repeated here.
type Tab = Exclude<FollowUpBucket, 'not_responded'>;

const PRIORITY_VARIANT: Record<FollowUpRow['priority'], BadgeVariant> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'accent',
  low: 'neutral',
};
const KIND_LABEL: Record<FollowUpRow['kind'], string> = {
  unanswered: 'Customer waiting',
  promised_follow_up: 'Promised follow-up',
  awaiting_customer: 'No reply from customer',
  reminder: 'Follow-up due',
};
const EMPTY: Record<Tab, string> = {
  follow_up_required: 'No follow-ups are due right now.',
  overdue_follow_up: 'Nothing is overdue.',
};

const waited = (days: number) => (days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`);

// Where each conversation stands, read from the thread itself — who wrote
// last and what was said — not from whether a message is marked read:
// answered, still waiting on you, due a follow-up, or overdue for one.
export function FollowUpAnalysisSection({ onOpenEmail }: { onOpenEmail: (emailId: string) => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['email-intelligence-follow-up-analysis'],
    queryFn: () => emailIntelligenceService.getFollowUpAnalysis(),
    refetchInterval: 120_000,
  });

  // Drafting reuses the existing follow-up flow (draft → review → approve →
  // send, under Follow-ups): nothing is ever sent from here.
  const draft = async (row: FollowUpRow) => {
    setBusyId(row.id);
    try {
      const reminderId = row.reminderId ?? (await emailIntelligenceService.ensureFollowUpReminder(row.emailId))._id;
      const reminder = await emailIntelligenceService.generateFollowUpDraft(reminderId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-up-analysis'] }),
        queryClient.invalidateQueries({ queryKey: ['email-intelligence-follow-ups'] }),
      ]);
      if (reminder.draftStatus === 'pending_review') {
        toast.success('Draft ready — review and send it under “Follow-up drafts and reminders” below.');
        // Bring that list into view: the draft is waiting there, and nothing is sent until it is approved.
        document.getElementById('follow-up-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        toast.error('The draft couldn’t be written. Try again in a minute.');
      }
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <Skeleton height={140} />;
  if (isError || !data) {
    return (
      <div className={styles.errorState} role="alert">
        <span>Couldn’t analyze your conversations. {extractErrorMessage(error)}</span>
        <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const cards: ChoiceCardItem<Tab>[] = [
    {
      id: 'overdue_follow_up',
      label: 'Overdue',
      description: 'Promised or expected, and late',
      icon: FiAlertTriangle,
      count: data.counts.overdue_follow_up,
      tone: 'danger',
    },
    {
      id: 'follow_up_required',
      label: 'Due now',
      description: 'You replied or promised; time to check in',
      icon: FiClock,
      count: data.counts.follow_up_required,
      tone: 'accent',
    },
  ];
  // Opens on whatever is most pressing.
  const active: Tab = tab ?? (data.counts.overdue_follow_up > 0 ? 'overdue_follow_up' : 'follow_up_required');
  const rows = data.rows.filter((r) => r.bucket === active);

  return (
    <div className={styles.formGrid}>
      <ChoiceCards ariaLabel="Follow-ups" items={cards} activeId={active} onChange={setTab} />

      {rows.length === 0 ? (
        <EmptyState compact icon={FiCheckCircle} title="All clear" description={EMPTY[active]} />
      ) : (
        rows.map((row) => (
          <article key={row.id} className={styles.followUpRow}>
            <header className={styles.followUpHead}>
              <div className={styles.listItemMain}>
                <span className={styles.listItemTitle}>{row.company ?? row.customer}</span>
                <span className={styles.listItemMeta}>
                  {row.company ? `${row.customer} · ` : ''}
                  {row.subject}
                </span>
              </div>
              <div className={styles.badgeRow}>
                <Badge variant="neutral">{KIND_LABEL[row.kind]}</Badge>
                <Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority} priority</Badge>
              </div>
            </header>

            <p className={styles.followUpReason}>
              {row.reason} <strong>{row.suggestedAction}</strong>
            </p>

            {/* The detail is one click away instead of on every card. */}
            {(row.lastCustomerMessage?.preview || row.suggestedMessage) && (
              <details className={styles.followUpDetails}>
                <summary>
                  Waiting {waited(row.daysWaiting)}
                  {row.lastResponseAt ? ` · you last wrote ${dayjs(row.lastResponseAt).format('D MMM')}` : ''} · show
                  messages
                </summary>
                {row.lastCustomerMessage?.preview && (
                  <blockquote className={styles.followUpQuote}>{row.lastCustomerMessage.preview}</blockquote>
                )}
                {row.suggestedMessage && (
                  <div className={styles.followUpDraft}>
                    <strong>Suggested message (draft — not sent)</strong>
                    <p>{row.suggestedMessage}</p>
                  </div>
                )}
              </details>
            )}

            <div className={styles.badgeRow}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                leftIcon={<FiMail />}
                onClick={() => onOpenEmail(row.emailId)}
              >
                Open email
              </Button>
              {row.kind !== 'unanswered' && !row.suggestedMessage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  leftIcon={<FiEdit3 />}
                  loading={busyId === row.id}
                  onClick={() => void draft(row)}
                >
                  Draft follow-up
                </Button>
              )}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
