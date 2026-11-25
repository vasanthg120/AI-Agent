import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { FiArrowUpRight, FiCheckSquare, FiChevronRight, FiClock, FiCornerUpLeft, FiInbox, FiMail, FiMic, FiPhoneIncoming, FiPhoneMissed, FiPhoneOutgoing, FiUploadCloud } from 'react-icons/fi';
import { EmptyState, Modal, Skeleton } from '@/components/ui';
import { formatAmountIn, formatINR } from '@/utils/currency';
import {
  formatTalkTime,
  formatWait,
  teamActivityService,
  type TeamCallItem,
  type TeamDealItem,
  type CallFilter,
  type TeamEmailItem,
  type TeamFollowUpItem,
  type TeamListItem,
  type TeamListKind,
  type TeamPeriodValue,
  type TeamSentEmailItem,
} from '@/services/teamActivityService';
import { openDealDrawer } from '@/stores/dealDrawerStore';
import { CallSessionViewer } from '@/features/call-copilot/components/CallSessionViewer';
import { OUTCOME_META } from '@/features/call-copilot/callMeta';
import { CALL_FILTER_TITLES, LIST_TITLES, scoreTone } from './metrics';
import { describePeriod } from './PeriodPicker';
import { TaskButtons } from './TaskButtons';
import taskStyles from './TeamTasks.module.css';
import styles from './TeamActivity.module.css';

dayjs.extend(relativeTime);

const at = (iso: string) => dayjs(iso).format('D MMM, h:mm a');

const CATEGORY_LABEL: Record<string, string> = {
  urgent: 'Urgent',
  needs_response: 'Needs a reply',
  waiting_for_customer: 'Waiting for the customer',
  follow_up_required: 'Follow-up due',
  responded: 'Replied',
  informational: 'No reply needed',
  completed: 'Closed',
};

interface ListFilters {
  organizationId?: string;
  userId?: string;
  callFilter?: CallFilter;
}

const money = (value: number, currency?: string) => (currency ? formatAmountIn(value, currency) : formatINR(value));

const CALL_STATUS: Record<string, string> = { no_answer: 'No answer', busy: 'Busy', failed: 'Didn’t connect', cancelled: 'Cancelled', initiated: 'Ringing', in_progress: 'In progress' };

/** The title of a list: its kind, or the kind of call it is narrowed to. */
export function listTitle(kind: TeamListKind, callFilter?: CallFilter): string {
  return kind === 'calls' && callFilter ? CALL_FILTER_TITLES[callFilter] : LIST_TITLES[kind];
}

// The records behind one number — the calls, emails or deals themselves. A
// call opens its summary, AI Coach report and recording; a deal opens the deal
// panel. Used inside a person's page and in the pop-up behind every tile.
export function ActivityList({ kind, period, filters, showPerson }: { kind: TeamListKind; period: TeamPeriodValue; filters: ListFilters; showPerson: boolean }) {
  const [openCall, setOpenCall] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-activity-list', kind, period, filters],
    queryFn: () => teamActivityService.list(kind, period, filters),
  });

  if (isLoading) {
    return (
      <div className={styles.listSkeleton}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={58} />
        ))}
      </div>
    );
  }
  if (isError || !data) return <EmptyState compact icon={FiInbox} title="This list couldn’t be loaded" description="Please try again in a moment." />;
  if (data.items.length === 0)
    return (
      <EmptyState
        compact
        icon={FiInbox}
        title={kind === 'pipeline' ? 'No open deals owned' : kind === 'follow_ups' ? 'No tasks or follow-ups' : `No ${listTitle(kind, filters.callFilter).toLowerCase()} ${describePeriod(period)}`}
      />
    );

  return (
    <>
      {data.total > data.items.length && (
        <p className={styles.listNote}>
          Showing the latest {data.items.length} of {data.total}.
        </p>
      )}
      <ul className={styles.recordList}>
        {data.items.map((item) => (
          <li key={`${item.businessId}-${item.id}`}>
            <Row kind={kind} item={item} showPerson={showPerson} onOpenCall={setOpenCall} />
          </li>
        ))}
      </ul>
      <CallSessionViewer sessionId={openCall} onClose={() => setOpenCall(null)} />
    </>
  );
}

function Who({ item, showPerson }: { item: TeamListItem; showPerson: boolean }) {
  if (!showPerson) return null;
  const parts = [item.personName, item.businessName].filter(Boolean);
  return parts.length ? <span className={styles.recordWho}>{parts.join(' · ')}</span> : null;
}

function Row({ kind, item, showPerson, onOpenCall }: { kind: TeamListKind; item: TeamListItem; showPerson: boolean; onOpenCall: (id: string) => void }) {
  if (kind === 'calls') return <CallRow call={item as TeamCallItem} showPerson={showPerson} onOpen={onOpenCall} />;
  if (kind === 'deals_created' || kind === 'deals_won' || kind === 'deals_lost' || kind === 'pipeline') return <DealRow deal={item as TeamDealItem} showPerson={showPerson} pipeline={kind === 'pipeline'} />;
  if (kind === 'follow_ups') return <FollowUpRow item={item as TeamFollowUpItem} showPerson={showPerson} />;
  if (kind === 'emails_sent') return <SentRow email={item as TeamSentEmailItem} showPerson={showPerson} />;
  return <EmailRow email={item as TeamEmailItem} kind={kind} showPerson={showPerson} />;
}

function CallRow({ call, showPerson, onOpen }: { call: TeamCallItem; showPerson: boolean; onOpen: (id: string) => void }) {
  const icon =
    call.kind === 'live' ? <FiMic /> : call.kind === 'upload' ? <FiUploadCloud /> : !call.connected ? <FiPhoneMissed /> : call.direction === 'inbound' ? <FiPhoneIncoming /> : <FiPhoneOutgoing />;
  const what =
    call.kind === 'live' ? 'Recorded call' : call.kind === 'upload' ? 'Uploaded recording' : `${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call`;
  const outcome = call.outcome ? OUTCOME_META[call.outcome as keyof typeof OUTCOME_META] : undefined;
  const clickable = !!call.sessionId;
  const content = (
    <>
      <span className={clsx(styles.recordIcon, !call.connected && styles.recordIconMuted)} aria-hidden>
        {icon}
      </span>
      <span className={styles.recordMain}>
        <span className={styles.recordTitle}>{call.headline ?? call.customer ?? what}</span>
        <span className={styles.recordMeta}>
          {[call.headline ? call.customer : undefined, call.customerNumber && call.customerNumber !== call.customer ? call.customerNumber : undefined, what, call.durationSeconds ? formatTalkTime(call.durationSeconds) : undefined, at(call.at)]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={styles.recordChips}>
          <Who item={call} showPerson={showPerson} />
          {outcome && <span className={clsx(styles.chip, styles[`chip_${outcome.tone}`])}>{outcome.label}</span>}
          {call.kind === 'phone' && !call.connected && <span className={clsx(styles.chip, styles.chip_warning)}>{CALL_STATUS[call.status] ?? 'Not answered'}</span>}
          {call.sessionStatus === 'processing' && <span className={clsx(styles.chip, styles.chip_info)}>Transcribing</span>}
          {call.failure && (
            <span className={clsx(styles.chip, styles.chip_danger)} title={call.failure}>
              Transcription failed
            </span>
          )}
        </span>
      </span>
      <span className={styles.recordEnd}>
        {call.score !== undefined ? (
          <span className={clsx(styles.scoreBadge, styles[`score_${scoreTone(call.score)}`])} title="AI Coach score out of 10">
            {call.score}
          </span>
        ) : (
          <span className={styles.noScore} title={call.sessionId ? 'Not scored' : 'No recording'}>
            —
          </span>
        )}
        {clickable && <FiChevronRight className={styles.recordChevron} aria-hidden />}
      </span>
    </>
  );
  return clickable ? (
    <button type="button" className={clsx(styles.record, styles.recordClickable)} onClick={() => onOpen(call.sessionId!)} title="Open the call">
      {content}
    </button>
  ) : (
    <div className={styles.record}>{content}</div>
  );
}

function DealRow({ deal, showPerson, pipeline }: { deal: TeamDealItem; showPerson: boolean; pipeline?: boolean }) {
  const content = (
    <>
      <span className={clsx(styles.recordIcon, styles[`deal_${deal.status}`])} aria-hidden>
        <FiArrowUpRight />
      </span>
      <span className={styles.recordMain}>
        <span className={styles.recordTitle}>{deal.name}</span>
        <span className={styles.recordMeta}>
          {(pipeline
            ? ['Open', deal.closes ? `closes ${dayjs(deal.closes).format('D MMM YYYY')}` : 'no closing date', deal.provider]
            : [deal.status === 'open' ? 'Open' : deal.status === 'won' ? 'Won' : 'Lost', deal.provider, at(deal.at)]
          )
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={styles.recordChips}>
          {deal.personName || pipeline ? (
            <Who item={deal} showPerson={showPerson} />
          ) : (
            <span className={clsx(styles.chip, styles.chip_warning)} title="Link this CRM salesperson to a login in Settings → Deal Assignment">
              {deal.sharedAccount ? `Shared account: ${deal.crmOwner}` : `CRM: ${deal.crmOwner} — not linked`}
            </span>
          )}
          {deal.byAi && <span className={clsx(styles.chip, styles.chip_info)}>By AI</span>}
        </span>
      </span>
      <span className={styles.recordEnd}>
        <strong className={styles.recordValue}>{deal.value ? money(deal.value, deal.currency) : '—'}</strong>
        {deal.dealId && <FiChevronRight className={styles.recordChevron} aria-hidden />}
      </span>
    </>
  );
  return deal.dealId ? (
    <button type="button" className={clsx(styles.record, styles.recordClickable)} onClick={() => openDealDrawer(deal.dealId!)} title="Open the deal">
      {content}
    </button>
  ) : (
    <div className={styles.record}>{content}</div>
  );
}

/** Where a task came from, in a word or two. */
function taskOrigin(item: TeamFollowUpItem): string {
  if (item.source === 'email') return 'Email follow-up';
  if (item.origin === 'deal') return 'Deal task';
  if (item.origin === 'job') return 'Job task';
  if (item.origin === 'customer') return 'Customer task';
  return item.givenBy ? `Given by ${item.givenBy}` : 'Task';
}

function FollowUpRow({ item, showPerson }: { item: TeamFollowUpItem; showPerson: boolean }) {
  const done = item.status === 'done';
  // A task its viewer may move along gets Start / Done; the deal (if any) opens from its own link.
  const movable = item.source === 'task' && !!item.editable;
  const content = (
    <>
      <span className={clsx(styles.recordIcon, done ? styles.recordIconOut : item.overdue ? styles.recordIconDanger : styles.recordIconWarning)} aria-hidden>
        {done ? <FiCheckSquare /> : item.source === 'email' ? <FiMail /> : <FiClock />}
      </span>
      <span className={styles.recordMain}>
        <span className={styles.recordTitle}>{item.title}</span>
        <span className={styles.recordMeta}>
          {[taskOrigin(item), item.business, done ? `done ${item.completedAt ? at(item.completedAt) : ''}` : item.dueDate ? `due ${at(item.dueDate)}` : 'no due date']
            .filter(Boolean)
            .join(' · ')}
        </span>
        {item.note && <span className={taskStyles.note}>{item.note}</span>}
        <span className={styles.recordChips}>
          <Who item={item} showPerson={showPerson} />
          {!done && item.inProgress && <span className={clsx(styles.chip, styles.chip_info)}>In progress</span>}
          {!done && item.priority === 'high' && <span className={clsx(styles.chip, styles.chip_warning)}>High priority</span>}
          {!done && item.overdue && <span className={clsx(styles.chip, styles.chip_danger)}>Overdue</span>}
          {done && <span className={clsx(styles.chip, styles.chip_success)}>Done</span>}
        </span>
        {movable && (
          <span className={taskStyles.taskButtons}>
            <TaskButtons task={item} />
            {item.dealId && (
              <button type="button" className={taskStyles.taskButton} onClick={() => openDealDrawer(item.dealId!)}>
                Open the deal
              </button>
            )}
          </span>
        )}
      </span>
      {item.dealId && !movable && (
        <span className={styles.recordEnd}>
          <FiChevronRight className={styles.recordChevron} aria-hidden />
        </span>
      )}
    </>
  );
  return item.dealId && !movable ? (
    <button type="button" className={clsx(styles.record, styles.recordClickable)} onClick={() => openDealDrawer(item.dealId!)} title="Open the deal">
      {content}
    </button>
  ) : (
    <div className={styles.record}>{content}</div>
  );
}

function SentRow({ email, showPerson }: { email: TeamSentEmailItem; showPerson: boolean }) {
  return (
    <div className={styles.record}>
      <span className={clsx(styles.recordIcon, styles.recordIconOut)} aria-hidden>
        {email.isReply ? <FiCornerUpLeft /> : <FiArrowUpRight />}
      </span>
      <span className={styles.recordMain}>
        <span className={styles.recordTitle}>{email.subject}</span>
        <span className={styles.recordMeta}>
          {[email.isReply ? 'Reply' : 'New email', email.to ? `to ${email.to}` : undefined, at(email.at)].filter(Boolean).join(' · ')}
        </span>
        {email.preview && <span className={styles.recordPreview}>{email.preview}</span>}
        <span className={styles.recordChips}>
          <Who item={email} showPerson={showPerson} />
        </span>
      </span>
    </div>
  );
}

function EmailRow({ email, kind, showPerson }: { email: TeamEmailItem; kind: TeamListKind; showPerson: boolean }) {
  const waitingSince = kind === 'emails_not_replied' || kind === 'emails_missed' || kind === 'emails_unanswered' ? dayjs(email.receivedAt).fromNow(true) : undefined;
  // How long the customer waited (a reply only marked as sent has no real time).
  const waited =
    email.respondedAt && (email.respondedVia === 'app' || email.respondedVia === 'outlook') ? (new Date(email.respondedAt).getTime() - new Date(email.receivedAt).getTime()) / 1000 : null;
  return (
    <div className={styles.record}>
      <span className={clsx(styles.recordIcon, kind === 'emails_missed' ? styles.recordIconDanger : kind === 'emails_not_replied' || kind === 'emails_unanswered' ? styles.recordIconWarning : styles.recordIconIn)} aria-hidden>
        {kind === 'emails_replied' ? <FiCornerUpLeft /> : <FiInbox />}
      </span>
      <span className={styles.recordMain}>
        <span className={styles.recordTitle}>{email.subject || '(no subject)'}</span>
        <span className={styles.recordMeta}>
          {[
            `From ${email.from}${email.business ? ` (${email.business})` : ''}`,
            `received ${at(email.receivedAt)}`,
            email.respondedAt ? `replied ${at(email.respondedAt)}${email.respondedVia === 'outlook' ? ' in Outlook' : email.respondedVia === 'app' ? ' in HaiVE' : ''}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {email.summary && <span className={styles.recordPreview}>{email.summary}</span>}
        <span className={styles.recordChips}>
          <Who item={email} showPerson={showPerson} />
          {waitingSince && <span className={clsx(styles.chip, kind === 'emails_missed' ? styles.chip_danger : styles.chip_warning)}>Waiting {waitingSince}</span>}
          {!waitingSince && waited !== null && waited >= 0 && <span className={styles.chip}>Replied after {formatWait(waited)}</span>}
          {!waitingSince && CATEGORY_LABEL[email.category] && <span className={styles.chip}>{CATEGORY_LABEL[email.category]}</span>}
        </span>
      </span>
    </div>
  );
}

/** The list behind a tile, in a pop-up. */
export function ActivityListModal({
  kind,
  onClose,
  period,
  filters,
  showPerson,
  subtitle,
}: {
  kind: TeamListKind | null;
  onClose: () => void;
  period: TeamPeriodValue;
  filters: ListFilters;
  showPerson: boolean;
  subtitle?: string;
}) {
  return (
    <Modal
      open={!!kind}
      onClose={onClose}
      title={kind ? (kind === 'pipeline' ? 'Open pipeline now' : kind === 'follow_ups' ? 'Tasks & follow-ups: open now, and done ' + describePeriod(period) : `${listTitle(kind, filters.callFilter)} ${describePeriod(period)}`) : ''}
      description={subtitle}
      maxWidth={720}
    >
      {kind && <ActivityList kind={kind} period={period} filters={filters} showPerson={showPerson} />}
    </Modal>
  );
}
