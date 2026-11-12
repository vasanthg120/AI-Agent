import { axiosClient } from '@/api/axiosClient';

// Agent Activity and the Dashboard's Team Performance (backend/src/team-activity).
// Whose figures come back is decided by the server from who is signed in: the
// Main Account owner every business, an owner/admin their team, a manager
// their store, anyone else themselves.

export type TeamPeriod = 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'previous_month' | 'custom';

export interface TeamPeriodValue {
  period: TeamPeriod;
  /** Custom only: "YYYY-MM-DD", both days included. */
  from?: string;
  to?: string;
}

export interface ActivityCounts {
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  wonValue: number;
  openDeals: number;
  pipelineValue: number;
  emailsSent: number;
  emailsReceived: number;
  emailsReplied: number;
  emailsNotReplied: number;
  emailsMissed: number;
  customerReplies: number;
  awaitingCustomer: number;
  calls: number;
  callsMade: number;
  callsReceived: number;
  callsConnected: number;
  callsMissed: number;
  talkSeconds: number;
  avgCallSeconds: number | null;
  scoredCalls: number;
  avgCallScore: number | null;
  followUpsCompleted: number;
  followUpsPending: number;
  followUpsOverdue: number;
}

export interface TeamActivityPerson extends ActivityCounts {
  userId: string;
  name: string;
  email?: string;
  role: string;
  active: boolean;
  mainAccountMember: boolean;
  businessId: string;
  businessName: string;
  currency: string;
}

export interface TeamActivityBusiness {
  id: string;
  name: string;
  isMain: boolean;
  isCurrent: boolean;
  timeZone: string;
  currency: string;
  from: string;
  to: string;
  totals: ActivityCounts;
  employees: number;
  activeEmployees: number;
}

export interface TeamActivityOverview {
  team: boolean;
  acrossBusinesses: boolean;
  businesses: TeamActivityBusiness[];
  totals: ActivityCounts;
  summary: { employees: number; activeEmployees: number; responseRatePct: number | null; followUpCompletionPct: number | null; currency: string | null };
  people: TeamActivityPerson[];
  unattributedDeals: { total: number; byCrmOwner: { label: string; shared: boolean; count: number }[] };
  generatedAt: string;
}

export type TeamListKind =
  | 'calls'
  | 'emails_sent'
  | 'emails_received'
  | 'emails_replied'
  | 'emails_not_replied'
  | 'emails_missed'
  | 'emails_customer_replies'
  | 'emails_awaiting_customer'
  | 'deals_created'
  | 'deals_won'
  | 'deals_lost'
  | 'pipeline'
  | 'follow_ups';

export type CallFilter = 'made' | 'received' | 'connected' | 'missed' | 'scored';

interface ListedBy {
  personId?: string;
  personName?: string;
  businessId: string;
  businessName: string;
  currency?: string;
}

export interface TeamCallItem extends ListedBy {
  id: string;
  kind: 'phone' | 'live' | 'upload';
  direction?: 'inbound' | 'outbound';
  at: string;
  customer?: string;
  customerNumber?: string;
  durationSeconds?: number;
  connected: boolean;
  status: string;
  sessionId?: string;
  sessionStatus?: string;
  headline?: string;
  outcome?: string;
  score?: number;
  failure?: string;
  dealId?: string;
}

export interface TeamSentEmailItem extends ListedBy {
  id: string;
  at: string;
  sentAt: string;
  subject: string;
  to: string;
  preview: string;
  isReply: boolean;
}

export interface TeamEmailItem extends ListedBy {
  id: string;
  at: string;
  receivedAt: string;
  subject: string;
  from: string;
  fromAddress: string;
  business?: string;
  respondedAt?: string;
  respondedVia?: 'app' | 'outlook' | 'thread';
  category: string;
  intent?: string;
  summary?: string;
  nextAction?: string;
}

export interface TeamDealItem extends ListedBy {
  id: string;
  dealId?: string;
  name: string;
  value: number;
  status: 'open' | 'won' | 'lost';
  provider?: string;
  byAi: boolean;
  at: string;
  crmOwner: string;
  sharedAccount: boolean;
  // Open pipeline only: its expected closing day.
  closes?: string;
}

export interface TeamFollowUpItem extends ListedBy {
  id: string;
  source: 'email' | 'task';
  title: string;
  business?: string;
  dueDate?: string;
  status: 'pending' | 'done';
  overdue: boolean;
  completedAt?: string;
  dealId?: string;
  at: string;
}

export type TeamListItem = TeamCallItem | TeamSentEmailItem | TeamEmailItem | TeamDealItem | TeamFollowUpItem;

export interface TeamTrendPoint {
  date: string;
  label: string;
  calls: number;
  talkSeconds: number;
  emailsSent: number;
  emailsReplied: number;
  dealsCreated: number;
  dealsWon: number;
}

export interface TeamScopeInfo {
  team: boolean;
  acrossBusinesses: boolean;
  businesses: { id: string; name: string; isMain: boolean; isCurrent: boolean; timeZone: string }[];
}

function params(value: TeamPeriodValue, extra: { organizationId?: string; userId?: string; callFilter?: CallFilter } = {}) {
  return {
    period: value.period,
    ...(value.period === 'custom' ? { from: value.from, to: value.to } : {}),
    ...(extra.organizationId && extra.organizationId !== 'all' ? { organizationId: extra.organizationId } : {}),
    ...(extra.userId ? { userId: extra.userId } : {}),
    ...(extra.callFilter ? { callFilter: extra.callFilter } : {}),
  };
}

export const teamActivityService = {
  async scope(): Promise<TeamScopeInfo> {
    const { data } = await axiosClient.get<TeamScopeInfo>('/team-activity/scope');
    return data;
  },

  async overview(value: TeamPeriodValue, filters: { organizationId?: string; userId?: string } = {}): Promise<TeamActivityOverview> {
    const { data } = await axiosClient.get<TeamActivityOverview>('/team-activity/overview', { params: params(value, filters) });
    return data;
  },

  async trend(value: TeamPeriodValue, filters: { organizationId?: string; userId?: string } = {}): Promise<{ granularity: 'day' | 'week'; points: TeamTrendPoint[] }> {
    const { data } = await axiosClient.get<{ granularity: 'day' | 'week'; points: TeamTrendPoint[] }>('/team-activity/trend', { params: params(value, filters) });
    return data;
  },

  async list<T extends TeamListItem = TeamListItem>(
    kind: TeamListKind,
    value: TeamPeriodValue,
    filters: { organizationId?: string; userId?: string; callFilter?: CallFilter } = {},
  ): Promise<{ kind: TeamListKind; items: T[]; total: number }> {
    const { data } = await axiosClient.get<{ kind: TeamListKind; items: T[]; total: number }>('/team-activity/list', {
      params: { kind, ...params(value, filters) },
    });
    return data;
  },
};

/** "1h 05m", "12m", "45s" — talk time. */
export function formatTalkTime(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
