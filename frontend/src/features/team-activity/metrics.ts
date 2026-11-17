import type { IconType } from 'react-icons';
import {
  FiAlertCircle,
  FiArrowDownLeft,
  FiArrowUpRight,
  FiAward,
  FiBriefcase,
  FiCheckCircle,
  FiCheckSquare,
  FiClock,
  FiCornerUpLeft,
  FiHelpCircle,
  FiInbox,
  FiPhone,
  FiPhoneMissed,
  FiSend,
  FiTrendingUp,
  FiWatch,
  FiXCircle,
} from 'react-icons/fi';
import { formatAmountIn } from '@/utils/currency';
import { formatTalkTime, type ActivityCounts, type CallFilter, type TeamListKind } from '@/services/teamActivityService';

export type MetricKey =
  | 'dealsCreated'
  | 'dealsWon'
  | 'dealsLost'
  | 'pipelineValue'
  | 'emailsSent'
  | 'emailsReplied'
  | 'emailsNotReplied'
  | 'emailsMissed'
  | 'customerReplies'
  | 'awaitingCustomer'
  | 'calls'
  | 'callsMade'
  | 'callsReceived'
  | 'callsMissed'
  | 'talkSeconds'
  | 'avgCallSeconds'
  | 'avgCallScore'
  | 'followUpsCompleted'
  | 'followUpsPending';

export type MetricGroup = 'sales' | 'email' | 'calls' | 'followups';

export const GROUP_LABELS: Record<MetricGroup, string> = {
  sales: 'Deals',
  email: 'Email',
  calls: 'Calls',
  followups: 'Follow-ups',
};

export interface MetricDef {
  key: MetricKey;
  group: MetricGroup;
  label: string;
  /** Column heading in the people table. */
  column: string;
  icon: IconType;
  list: TeamListKind;
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
const minutes = (seconds: number | null) => (seconds === null ? '—' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`);

// Every figure Agent Activity and Team Performance show, defined once — the
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
    key: 'emailsNotReplied',
    group: 'email',
    label: 'Not replied yet',
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
    key: 'emailsMissed',
    group: 'email',
    label: 'Missed',
    column: 'Missed',
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
    column: 'Missed',
    icon: FiPhoneMissed,
    list: 'calls',
    callFilter: 'missed',
    meaning: 'Phone calls nobody answered — outgoing or incoming.',
    alert: 'warning',
    value: (c) => String(c.callsMissed),
    sortValue: (c) => c.callsMissed,
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
    label: 'Follow-ups done',
    column: 'Done',
    icon: FiCheckSquare,
    list: 'follow_ups',
    meaning: 'Email follow-ups and customer tasks completed in the period.',
    value: (c) => String(c.followUpsCompleted),
    sortValue: (c) => c.followUpsCompleted,
  },
  {
    key: 'followUpsPending',
    group: 'followups',
    label: 'Follow-ups pending',
    column: 'Pending',
    icon: FiClock,
    list: 'follow_ups',
    meaning: 'Email follow-ups and customer tasks still open now; the overdue ones are past their due date.',
    alert: 'warning',
    value: (c) => String(c.followUpsPending),
    sortValue: (c) => c.followUpsPending,
    sub: (c) => (c.followUpsOverdue ? `${c.followUpsOverdue} overdue` : undefined),
  },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricDef>;

/** The people table's column sets: a short overview, then every figure of one kind. */
export const COLUMN_SETS: { id: 'overview' | MetricGroup; label: string; keys: MetricKey[] }[] = [
  { id: 'overview', label: 'Overview', keys: ['dealsCreated', 'dealsWon', 'emailsSent', 'emailsReplied', 'emailsMissed', 'calls', 'talkSeconds', 'avgCallScore'] },
  { id: 'sales', label: 'Deals', keys: ['dealsCreated', 'dealsWon', 'dealsLost', 'pipelineValue'] },
  { id: 'email', label: 'Email', keys: ['emailsSent', 'emailsReplied', 'emailsNotReplied', 'emailsMissed', 'customerReplies', 'awaitingCustomer'] },
  { id: 'calls', label: 'Calls', keys: ['calls', 'callsMade', 'callsReceived', 'callsMissed', 'talkSeconds', 'avgCallSeconds', 'avgCallScore'] },
  { id: 'followups', label: 'Follow-ups', keys: ['followUpsCompleted', 'followUpsPending'] },
];

export const LIST_TITLES: Record<TeamListKind, string> = {
  calls: 'Calls',
  emails_sent: 'Emails sent',
  emails_received: 'Customer emails received',
  emails_replied: 'Customer emails replied to',
  emails_not_replied: 'Waiting for a reply',
  emails_missed: 'Missed emails',
  emails_customer_replies: 'Customer replies',
  emails_awaiting_customer: 'Awaiting the customer',
  deals_created: 'Deals created',
  deals_won: 'Deals won',
  deals_lost: 'Deals lost',
  pipeline: 'Open pipeline',
  follow_ups: 'Follow-ups',
};

export const CALL_FILTER_TITLES: Record<CallFilter, string> = {
  made: 'Calls made',
  received: 'Calls received',
  connected: 'Completed calls',
  missed: 'Missed calls',
  scored: 'Scored calls',
};

/** Score colour band, same cut-offs as the AI Coach. */
export function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 7) return 'success';
  if (score >= 5) return 'warning';
  return 'danger';
}
