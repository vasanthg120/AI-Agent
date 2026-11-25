import type { IconType } from 'react-icons';
import {
  FiAlertCircle,
  FiArrowDownLeft,
  FiArrowUpRight,
  FiActivity,
  FiAward,
  FiBriefcase,
  FiCheckCircle,
  FiCheckSquare,
  FiClock,
  FiCornerUpLeft,
  FiHelpCircle,
  FiDollarSign,
  FiInbox,
  FiMail,
  FiMonitor,
  FiPercent,
  FiPhone,
  FiPhoneCall,
  FiPhoneMissed,
  FiPhoneOff,
  FiSend,
  FiTrendingUp,
  FiWatch,
  FiXCircle,
} from 'react-icons/fi';
import { formatAmountIn } from '@/utils/currency';
import { formatTalkTime, formatWait, type ActivityCounts, type CallFilter, type TeamListKind } from '@/services/teamActivityService';

export type MetricKey =
  | 'dealsCreated'
  | 'dealsWon'
  | 'dealsLost'
  | 'wonValue'
  | 'dealConversionPct'
  | 'pipelineValue'
  | 'emailsSent'
  | 'emailsReceived'
  | 'emailsReplied'
  | 'avgResponseSeconds'
  | 'emailsNotReplied'
  | 'emailsUnanswered'
  | 'emailsMissed'
  | 'customerReplies'
  | 'awaitingCustomer'
  | 'calls'
  | 'callsMade'
  | 'callsReceived'
  | 'callsMissed'
  | 'callsUnanswered'
  | 'callConnectionRatePct'
  | 'callAnswerRatePct'
  | 'talkSeconds'
  | 'avgCallSeconds'
  | 'avgCallScore'
  | 'followUpsCompleted'
  | 'followUpsPending'
  | 'followUpsOverdue'
  | 'activeSeconds'
  | 'haiveSeconds';

export type MetricGroup = 'sales' | 'email' | 'calls' | 'followups' | 'time';

export const GROUP_LABELS: Record<MetricGroup, string> = {
  sales: 'Deals',
  email: 'Email',
  calls: 'Calls',
  followups: 'Tasks',
  time: 'Time',
};

export interface MetricDef {
  key: MetricKey;
  group: MetricGroup;
  label: string;
  /** Column heading in the people table. */
  column: string;
  icon: IconType;
  /** The records behind it; none for measured time (the App usage view shows that). */
  list?: TeamListKind;
  callFilter?: CallFilter;
  /** What the number counts, in one sentence (the tile's tooltip and the list's subtitle). */
  meaning: string;
  /** Worth noticing when above zero. */
  alert?: 'warning' | 'danger';
  value: (c: ActivityCounts, currency?: string | null) => string;
  sortValue: (c: ActivityCounts) => number;
  sub?: (c: ActivityCounts, currency?: string | null) => string | undefined;
}

const money = (value: number, currency?: string | null) => (currency ? formatAmountIn(value, currency) : value.toLocaleString());
const pct = (value: number | null) => (value === null ? '—' : `${value}%`);
const minutes = (seconds: number | null) => (seconds === null ? '—' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`);

// Every figure Employee Activity and Team Performance show, defined once — the
// tiles, the table's columns and the lists behind them all read from here.
export const METRICS: MetricDef[] = [
  // ---- deals ----
  {
    key: 'dealsCreated',
    group: 'sales',
    label: 'Deals created',
    column: 'Created',
    icon: FiBriefcase,
    list: 'deals_created',
    meaning: 'New deals: created in HaiVE by the person, or in the CRM by a salesperson linked to them in Deal Assignment.',
    value: (c) => String(c.dealsCreated),
    sortValue: (c) => c.dealsCreated,
  },
  {
    key: 'dealsWon',
    group: 'sales',
    label: 'Deals won',
    column: 'Won',
    icon: FiCheckCircle,
    list: 'deals_won',
    meaning: 'Deals won in the period, credited to their owner.',
    value: (c) => String(c.dealsWon),
    sortValue: (c) => c.dealsWon,
    sub: (c, currency) => (c.wonValue && currency ? `${money(c.wonValue, currency)} won` : undefined),
  },
  {
    key: 'dealsLost',
    group: 'sales',
    label: 'Deals lost',
    column: 'Lost',
    icon: FiXCircle,
    list: 'deals_lost',
    meaning: 'Deals lost in the period, credited to their owner.',
    value: (c) => String(c.dealsLost),
    sortValue: (c) => c.dealsLost,
  },
  {
    key: 'wonValue',
    group: 'sales',
    label: 'Revenue won',
    column: 'Revenue',
    icon: FiDollarSign,
    list: 'deals_won',
    meaning: 'The value of the deals won in the period.',
    value: (c, currency) => money(c.wonValue, currency),
    sortValue: (c) => c.wonValue,
    sub: (c) => (c.dealsWon ? `${c.dealsWon} deal${c.dealsWon === 1 ? '' : 's'} won` : undefined),
  },
  {
    key: 'dealConversionPct',
    group: 'sales',
    label: 'Win rate',
    column: 'Win rate',
    icon: FiPercent,
    list: 'deals_won',
    meaning: 'Of the deals closed in the period, the share won: won ÷ (won + lost).',
    value: (c) => pct(c.dealConversionPct),
    sortValue: (c) => c.dealConversionPct ?? -1,
    sub: (c) => (c.dealsWon + c.dealsLost ? `${c.dealsWon} of ${c.dealsWon + c.dealsLost} closed` : 'none closed'),
  },
  {
    key: 'pipelineValue',
    group: 'sales',
    label: 'Active pipeline',
    column: 'Pipeline',
    icon: FiTrendingUp,
    list: 'pipeline',
    meaning: 'Open deals each person owns right now, by value (not tied to the period).',
    value: (c, currency) => money(c.pipelineValue, currency),
    sortValue: (c) => c.pipelineValue,
    sub: (c) => `${c.openDeals} open deal${c.openDeals === 1 ? '' : 's'}`,
  },
  // ---- email ----
  {
    key: 'emailsSent',
    group: 'email',
    label: 'Emails sent',
    column: 'Sent',
    icon: FiSend,
    list: 'emails_sent',
    meaning: 'Every email that left their mailbox — written in HaiVE or in Outlook, replies and new emails.',
    value: (c) => String(c.emailsSent),
    sortValue: (c) => c.emailsSent,
  },
  {
    key: 'emailsReceived',
    group: 'email',
    label: 'Customer emails received',
    column: 'Received',
    icon: FiMail,
    list: 'emails_received',
    meaning: 'Business emails that arrived in their mailbox in the period (one conversation’s messages each count).',
    value: (c) => String(c.emailsReceived),
    sortValue: (c) => c.emailsReceived,
  },
  {
    key: 'emailsReplied',
    group: 'email',
    label: 'Replied to customers',
    column: 'Replied',
    icon: FiCornerUpLeft,
    list: 'emails_replied',
    meaning: 'Customer emails they answered (in HaiVE or in Outlook).',
    value: (c) => String(c.emailsReplied),
    sortValue: (c) => c.emailsReplied,
    sub: (c) => (c.emailsReceived ? `${c.emailsReceived} received` : undefined),
  },
  {
    key: 'avgResponseSeconds',
    group: 'email',
    label: 'Average reply time',
    column: 'Avg reply',
    icon: FiClock,
    list: 'emails_replied',
    meaning: 'How long customers waited for the replies sent in the period, on average — from the email arriving to the reply, written in HaiVE or Outlook.',
    value: (c) => formatWait(c.avgResponseSeconds),
    // Faster is better: sorting "high to low" puts the quickest first.
    sortValue: (c) => (c.avgResponseSeconds === null ? -1 : 1 / (1 + c.avgResponseSeconds)),
  },
  {
    key: 'emailsNotReplied',
    group: 'email',
    label: 'Awaiting reply',
    column: 'Waiting',
    icon: FiInbox,
    list: 'emails_not_replied',
    meaning: 'Customer emails still waiting for their reply, less than 24 hours old.',
    alert: 'warning',
    value: (c) => String(c.emailsNotReplied),
    sortValue: (c) => c.emailsNotReplied,
    sub: () => 'under 24 hours',
  },
  {
    key: 'emailsUnanswered',
    group: 'email',
    label: 'Unanswered',
    column: 'Unanswered',
    icon: FiHelpCircle,
    list: 'emails_unanswered',
    meaning: 'Customer emails that arrived in the period and still have no reply now, however old (one per conversation).',
    alert: 'warning',
    value: (c) => String(c.emailsUnanswered),
    sortValue: (c) => c.emailsUnanswered,
    sub: () => 'still owed a reply',
  },
  {
    key: 'emailsMissed',
    group: 'email',
    label: 'Missed',
    column: 'Missed emails',
    icon: FiAlertCircle,
    list: 'emails_missed',
    meaning: 'Customer emails that went 24 hours without a reply (counted on the day the 24 hours ran out).',
    alert: 'danger',
    value: (c) => String(c.emailsMissed),
    sortValue: (c) => c.emailsMissed,
    sub: () => 'no reply in 24h',
  },
  {
    key: 'customerReplies',
    group: 'email',
    label: 'Customer replies',
    column: 'Cust. replies',
    icon: FiArrowDownLeft,
    list: 'emails_customer_replies',
    meaning: 'Replies received from customers in an ongoing conversation.',
    value: (c) => String(c.customerReplies),
    sortValue: (c) => c.customerReplies,
  },
  {
    key: 'awaitingCustomer',
    group: 'email',
    label: 'Awaiting customer',
    column: 'Awaiting',
    icon: FiHelpCircle,
    list: 'emails_awaiting_customer',
    meaning: 'Their replies that asked the customer something, still unanswered by the customer.',
    value: (c) => String(c.awaitingCustomer),
    sortValue: (c) => c.awaitingCustomer,
  },
  // ---- calls ----
  {
    key: 'calls',
    group: 'calls',
    label: 'Calls',
    column: 'Calls',
    icon: FiPhone,
    list: 'calls',
    meaning: 'Phone calls made or received, and calls recorded or uploaded in Call Copilot.',
    value: (c) => String(c.calls),
    sortValue: (c) => c.calls,
    sub: (c) => (c.calls ? `${c.callsConnected} completed` : undefined),
  },
  {
    key: 'callsMade',
    group: 'calls',
    label: 'Calls made',
    column: 'Made',
    icon: FiArrowUpRight,
    list: 'calls',
    callFilter: 'made',
    meaning: 'Outgoing phone calls.',
    value: (c) => String(c.callsMade),
    sortValue: (c) => c.callsMade,
  },
  {
    key: 'callsReceived',
    group: 'calls',
    label: 'Calls received',
    column: 'Received',
    icon: FiArrowDownLeft,
    list: 'calls',
    callFilter: 'received',
    meaning: 'Incoming phone calls.',
    value: (c) => String(c.callsReceived),
    sortValue: (c) => c.callsReceived,
  },
  {
    key: 'callsMissed',
    group: 'calls',
    label: 'Missed calls',
    column: 'Missed calls',
    icon: FiPhoneMissed,
    list: 'calls',
    callFilter: 'missed',
    meaning: 'Incoming phone calls nobody answered.',
    alert: 'warning',
    value: (c) => String(c.callsMissed),
    sortValue: (c) => c.callsMissed,
    sub: (c) => (c.callAnswerRatePct !== null ? `${c.callAnswerRatePct}% of incoming answered` : undefined),
  },
  {
    key: 'callsUnanswered',
    group: 'calls',
    label: 'Unanswered calls',
    column: 'Unanswered',
    icon: FiPhoneOff,
    list: 'calls',
    callFilter: 'unanswered',
    meaning: 'Outgoing phone calls the other side didn’t pick up — no answer, busy or failed.',
    value: (c) => String(c.callsUnanswered),
    sortValue: (c) => c.callsUnanswered,
  },
  {
    key: 'callConnectionRatePct',
    group: 'calls',
    label: 'Connection rate',
    column: 'Connected',
    icon: FiPhoneCall,
    list: 'calls',
    callFilter: 'connected',
    meaning: 'Of the phone calls made and received, the share that connected.',
    value: (c) => pct(c.callConnectionRatePct),
    sortValue: (c) => c.callConnectionRatePct ?? -1,
    sub: (c) => (c.callsMade + c.callsReceived ? `${c.callsMade + c.callsReceived - c.callsMissed - c.callsUnanswered} of ${c.callsMade + c.callsReceived} phone calls` : undefined),
  },
  {
    key: 'callAnswerRatePct',
    group: 'calls',
    label: 'Answer rate',
    column: 'Answered',
    icon: FiPhoneCall,
    list: 'calls',
    callFilter: 'received',
    meaning: 'Of the incoming phone calls, the share someone answered.',
    value: (c) => pct(c.callAnswerRatePct),
    sortValue: (c) => c.callAnswerRatePct ?? -1,
  },
  {
    key: 'talkSeconds',
    group: 'calls',
    label: 'Talk time',
    column: 'Talk time',
    icon: FiClock,
    list: 'calls',
    callFilter: 'connected',
    meaning: 'Time spent speaking on connected phone calls and live Call Copilot calls (an uploaded recording’s length isn’t known).',
    value: (c) => formatTalkTime(c.talkSeconds),
    sortValue: (c) => c.talkSeconds,
  },
  {
    key: 'avgCallSeconds',
    group: 'calls',
    label: 'Average call',
    column: 'Avg call',
    icon: FiWatch,
    list: 'calls',
    callFilter: 'connected',
    meaning: 'Average length of the connected calls whose length is known.',
    value: (c) => minutes(c.avgCallSeconds),
    sortValue: (c) => c.avgCallSeconds ?? -1,
  },
  {
    key: 'avgCallScore',
    group: 'calls',
    label: 'Call score',
    column: 'Score',
    icon: FiAward,
    list: 'calls',
    callFilter: 'scored',
    meaning: 'The AI Coach’s average score (out of 10) for the calls it scored.',
    value: (c) => (c.avgCallScore === null ? '—' : `${c.avgCallScore}/10`),
    sortValue: (c) => c.avgCallScore ?? -1,
    sub: (c) => (c.scoredCalls ? `${c.scoredCalls} scored` : undefined),
  },
  // ---- follow-ups ----
  {
    key: 'followUpsCompleted',
    group: 'followups',
    label: 'Tasks done',
    column: 'Done',
    icon: FiCheckSquare,
    list: 'follow_ups',
    meaning: 'Tasks finished in the period — given by a manager, on a customer, a job or a deal — and email follow-ups done.',
    value: (c) => String(c.followUpsCompleted),
    sortValue: (c) => c.followUpsCompleted,
  },
  {
    key: 'followUpsPending',
    group: 'followups',
    label: 'Tasks open',
    column: 'Open',
    icon: FiClock,
    list: 'follow_ups',
    meaning: 'Tasks and email follow-ups not done yet, now; in progress = the person has started it.',
    value: (c) => String(c.followUpsPending),
    sortValue: (c) => c.followUpsPending,
    sub: (c) => (c.followUpsInProgress ? `${c.followUpsInProgress} in progress` : undefined),
  },
  {
    key: 'followUpsOverdue',
    group: 'followups',
    label: 'Tasks overdue',
    column: 'Overdue',
    icon: FiAlertCircle,
    list: 'follow_ups',
    meaning: 'Open tasks and follow-ups whose day has passed, now.',
    alert: 'danger',
    value: (c) => String(c.followUpsOverdue),
    sortValue: (c) => c.followUpsOverdue,
  },
  // ---- measured time ----
  {
    key: 'activeSeconds',
    group: 'time',
    label: 'Active time',
    column: 'Active time',
    icon: FiActivity,
    meaning: 'Measured working time: HaiVE in active use (a click, key press or scroll in the last 2 minutes) or on a call — a minute doing both counts once.',
    value: (c) => formatTalkTime(c.activeSeconds),
    sortValue: (c) => c.activeSeconds,
  },
  {
    key: 'haiveSeconds',
    group: 'time',
    label: 'Time in HaiVE',
    column: 'In HaiVE',
    icon: FiMonitor,
    meaning: 'Time with HaiVE in front and in use. An open tab nobody touches doesn’t count.',
    value: (c) => formatTalkTime(c.haiveSeconds),
    sortValue: (c) => c.haiveSeconds,
  },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricDef>;

/** The people table's column sets: a short overview, then every figure of one kind. */
export const COLUMN_SETS: { id: 'overview' | MetricGroup; label: string; keys: MetricKey[] }[] = [
  { id: 'overview', label: 'Overview', keys: ['activeSeconds', 'dealsCreated', 'dealsWon', 'emailsSent', 'emailsReplied', 'emailsMissed', 'calls', 'callsMissed', 'followUpsOverdue'] },
  { id: 'sales', label: 'Deals', keys: ['dealsCreated', 'dealsWon', 'dealsLost', 'dealConversionPct', 'wonValue', 'pipelineValue'] },
  { id: 'email', label: 'Email', keys: ['emailsSent', 'emailsReceived', 'emailsReplied', 'avgResponseSeconds', 'emailsNotReplied', 'emailsUnanswered', 'emailsMissed'] },
  { id: 'calls', label: 'Calls', keys: ['calls', 'callsMade', 'callsReceived', 'callsMissed', 'callsUnanswered', 'callConnectionRatePct', 'talkSeconds', 'avgCallScore'] },
  { id: 'followups', label: 'Tasks', keys: ['followUpsCompleted', 'followUpsPending', 'followUpsOverdue'] },
  { id: 'time', label: 'Time', keys: ['activeSeconds', 'haiveSeconds', 'talkSeconds'] },
];

export const LIST_TITLES: Record<TeamListKind, string> = {
  calls: 'Calls',
  emails_sent: 'Emails sent',
  emails_received: 'Customer emails received',
  emails_replied: 'Customer emails replied to',
  emails_not_replied: 'Waiting for a reply',
  emails_missed: 'Missed emails',
  emails_unanswered: 'Unanswered emails',
  emails_customer_replies: 'Customer replies',
  emails_awaiting_customer: 'Awaiting the customer',
  deals_created: 'Deals created',
  deals_won: 'Deals won',
  deals_lost: 'Deals lost',
  pipeline: 'Open pipeline',
  follow_ups: 'Tasks & follow-ups',
};

export const CALL_FILTER_TITLES: Record<CallFilter, string> = {
  made: 'Calls made',
  received: 'Calls received',
  connected: 'Completed calls',
  missed: 'Missed calls (incoming)',
  unanswered: 'Unanswered calls (outgoing)',
  scored: 'Scored calls',
};

/** Score colour band, same cut-offs as the AI Coach. */
export function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 7) return 'success';
  if (score >= 5) return 'warning';
  return 'danger';
}
