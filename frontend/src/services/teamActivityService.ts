import { axiosClient } from '@/api/axiosClient';

// Employee Activity and the Dashboard's Team Performance (backend/src/team-activity).
// Whose figures come back is decided by the server from who is signed in: the
// Main Account owner every business, an owner/admin their team, a manager
// their store, anyone else themselves.

export type TeamPeriod = 'today' | 'yesterday' | 'week' | 'last7' | 'last30' | 'month' | 'previous_month' | 'custom';

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
  // Won ÷ (won + lost) in the period.
  dealConversionPct: number | null;
  openDeals: number;
  pipelineValue: number;
  emailsSent: number;
  emailsReceived: number;
  emailsReplied: number;
  emailsNotReplied: number;
  emailsMissed: number;
  // Arrived in the period, still owed a reply now (however old).
  emailsUnanswered: number;
  // Average wait for the replies sent in the period (written in HaiVE or Outlook).
  avgResponseSeconds: number | null;
  customerReplies: number;
  awaitingCustomer: number;
  calls: number;
  callsMade: number;
  callsReceived: number;
  callsConnected: number;
  // Incoming nobody answered.
  callsMissed: number;
  // Outgoing the other side didn't pick up.
  callsUnanswered: number;
  callConnectionRatePct: number | null;
  callAnswerRatePct: number | null;
  talkSeconds: number;
  avgCallSeconds: number | null;
  scoredCalls: number;
  avgCallScore: number | null;
  // Tasks & follow-ups: done in the period; open now, of which started and past their day.
  followUpsCompleted: number;
  followUpsPending: number;
  followUpsInProgress: number;
  followUpsOverdue: number;
  // Measured time: HaiVE in active use or on a call (a minute counted once), and HaiVE alone.
  activeSeconds: number;
  haiveSeconds: number;
}

export interface TeamActivityPerson extends ActivityCounts {
  userId: string;
  name: string;
  email?: string;
  role: string;
  active: boolean;
  mainAccountMember: boolean;
  department?: string;
  businessId: string;
  businessName: string;
  currency: string;
  // Last time they were really active in HaiVE (any day).
  lastActiveAt?: string;
}

/** How one source of the figures gets its data, and when it last did. */
export interface SourceFreshness {
  businessId: string;
  businessName: string;
  key: string;
  label: string;
  mode: 'real_time' | 'on_open' | 'nightly';
  status: 'ok' | 'failing' | 'never' | 'not_connected';
  lastSuccessAt?: string;
}

/** Why someone may need a hand, in a line, with the list that shows it. */
export interface TeamSupportItem {
  personId: string;
  personName: string;
  businessId: string;
  businessName: string;
  severity: 'warning' | 'info';
  text: string;
  list?: TeamListKind;
  callFilter?: CallFilter;
}

export interface TeamDepartment {
  key: string;
  name: string;
  businessId: string;
  businessName: string;
  people: number;
  activePeople: number;
  followUpsCompleted: number;
  followUpsPending: number;
  followUpsInProgress: number;
  followUpsOverdue: number;
  emailsReplied: number;
  emailsMissed: number;
  calls: number;
  callsMissed: number;
  avgCallScore: number | null;
  dealsWon: number;
  needSupport: number;
}

export type TaskMove = 'todo' | 'in_progress' | 'done';

export interface GiveTaskInput {
  organizationId?: string;
  assigneeId: string;
  title: string;
  note?: string;
  dueDate?: string;
  priority?: 'high' | 'normal';
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
  attention: TeamSupportItem[];
  departments: TeamDepartment[];
  sources: SourceFreshness[];
  // Asked for with compare: the same totals for the period before.
  previous?: { from: string; to: string; totals: ActivityCounts };
  generatedAt: string;
}

export type UsageArea = 'crm' | 'email' | 'calls' | 'analytics' | 'assistant' | 'tasks' | 'files' | 'knowledge' | 'admin' | 'other';
export type AreaSeconds = Partial<Record<UsageArea, number>>;

export interface WorkSession {
  start: string;
  end: string;
  activeSeconds: number;
}

export interface UsageDay {
  date: string;
  activeSeconds: number;
  haiveSeconds: number;
  callSeconds: number;
  byArea: AreaSeconds;
  firstAt: string;
  lastAt: string;
  sessions: WorkSession[];
}

export interface SignInRow {
  at: string;
  kind: 'sign_in' | 'switch_in';
  device?: string;
  location?: string;
  signedOutAt?: string;
  open: boolean;
}

export interface UsagePerson {
  userId: string;
  name: string;
  role: string;
  active: boolean;
  mainAccountMember: boolean;
  businessId: string;
  businessName: string;
  activeSeconds: number;
  haiveSeconds: number;
  callSeconds: number;
  byArea: AreaSeconds;
  activeDays: number;
  avgActiveSecondsPerDay: number | null;
  firstAt?: string;
  lastAt?: string;
  lastActiveAt?: string;
  topArea?: UsageArea;
}

/** An app people work in, and what HaiVE can say about it: time measured, activity only, or nothing. */
export interface ConnectedApp {
  key: string;
  label: string;
  measure: 'time' | 'activity' | 'none';
  connected: boolean;
  seconds?: number;
  activity: { label: string; count: number }[];
  note: string;
}

export interface TeamUsageReport {
  team: boolean;
  acrossBusinesses: boolean;
  businesses: { id: string; name: string; timeZone: string; from: string; to: string }[];
  totals: {
    activeSeconds: number;
    haiveSeconds: number;
    callSeconds: number;
    byArea: AreaSeconds;
    people: number;
    activePeople: number;
    avgActiveSecondsPerPersonDay: number | null;
  };
  areas: { key: UsageArea; label: string; seconds: number }[];
  days: { date: string; activeSeconds: number; haiveSeconds: number; callSeconds: number; byArea: AreaSeconds; activePeople: number }[];
  people: UsagePerson[];
  apps: ConnectedApp[];
  person?: { days: UsageDay[]; signIns: SignInRow[] };
  measuredSince: string | null;
  generatedAt: string;
}

export type TeamListKind =
  | 'calls'
  | 'emails_sent'
  | 'emails_received'
  | 'emails_replied'
  | 'emails_not_replied'
  | 'emails_missed'
  | 'emails_unanswered'
  | 'emails_customer_replies'
  | 'emails_awaiting_customer'
  | 'deals_created'
  | 'deals_won'
  | 'deals_lost'
  | 'pipeline'
  | 'follow_ups';

// missed: incoming nobody answered · unanswered: outgoing the other side didn't pick up.
export type CallFilter = 'made' | 'received' | 'connected' | 'missed' | 'unanswered' | 'scored';

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
  // Tasks only (not email follow-ups):
  inProgress?: boolean;
  note?: string;
  priority?: 'high';
  givenBy?: string;
  origin?: 'team' | 'customer' | 'job' | 'deal';
  // The person looking may move it along.
  editable?: boolean;
}

export type TeamListItem = TeamCallItem | TeamSentEmailItem | TeamEmailItem | TeamDealItem | TeamFollowUpItem;

export interface TeamTrendPoint {
  date: string;
  label: string;
  calls: number;
  callsMade: number;
  callsReceived: number;
  callsMissed: number;
  callsUnanswered: number;
  talkSeconds: number;
  emailsSent: number;
  emailsReceived: number;
  emailsReplied: number;
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  wonValue: number;
  activeSeconds: number;
  haiveSeconds: number;
  activePeople: number;
}

export interface TeamScopeInfo {
  team: boolean;
  acrossBusinesses: boolean;
  businesses: { id: string; name: string; isMain: boolean; isCurrent: boolean; timeZone: string }[];
}

function params(value: TeamPeriodValue, extra: { organizationId?: string; userId?: string; callFilter?: CallFilter; compare?: boolean } = {}) {
  return {
    period: value.period,
    ...(value.period === 'custom' ? { from: value.from, to: value.to } : {}),
    ...(extra.organizationId && extra.organizationId !== 'all' ? { organizationId: extra.organizationId } : {}),
    ...(extra.userId ? { userId: extra.userId } : {}),
    ...(extra.callFilter ? { callFilter: extra.callFilter } : {}),
    ...(extra.compare ? { compare: 'true' } : {}),
  };
}

export const teamActivityService = {
  async scope(): Promise<TeamScopeInfo> {
    const { data } = await axiosClient.get<TeamScopeInfo>('/team-activity/scope');
    return data;
  },

  async overview(value: TeamPeriodValue, filters: { organizationId?: string; userId?: string; compare?: boolean } = {}): Promise<TeamActivityOverview> {
    const { data } = await axiosClient.get<TeamActivityOverview>('/team-activity/overview', { params: params(value, filters) });
    return data;
  },

  async trend(value: TeamPeriodValue, filters: { organizationId?: string; userId?: string } = {}): Promise<{ granularity: 'day' | 'week'; points: TeamTrendPoint[] }> {
    const { data } = await axiosClient.get<{ granularity: 'day' | 'week'; points: TeamTrendPoint[] }>('/team-activity/trend', { params: params(value, filters) });
    return data;
  },

  /** Measured time in HaiVE and on calls, the other apps people use, and (one person) work sessions and sign-ins. */
  async usage(value: TeamPeriodValue, filters: { organizationId?: string; userId?: string } = {}): Promise<TeamUsageReport> {
    const { data } = await axiosClient.get<TeamUsageReport>('/team-activity/usage', { params: params(value, filters) });
    return data;
  },

  /** Everything given to me: still to do, and what I finished in the last week. */
  async myTasks(): Promise<{ items: TeamFollowUpItem[]; open: number; inProgress: number; overdue: number }> {
    const { data } = await axiosClient.get<{ items: TeamFollowUpItem[]; open: number; inProgress: number; overdue: number }>('/team-tasks/mine');
    return data;
  },

  async giveTask(input: GiveTaskInput): Promise<TeamFollowUpItem> {
    const { data } = await axiosClient.post<TeamFollowUpItem>('/team-tasks', input);
    return data;
  },

  /** To do → in progress → done (or back); a manager may also change the day (null clears it). */
  async moveTask(id: string, change: { status?: TaskMove; dueDate?: string | null }): Promise<TeamFollowUpItem> {
    const { data } = await axiosClient.patch<TeamFollowUpItem>(`/team-tasks/${id}`, change);
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

/** "2d 4h", "3h 20m", "12m", "under a minute" — how long a customer waited for a reply. */
export function formatWait(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return 'under a minute';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "1h 05m", "12m", "45s" — talk time. */
export function formatTalkTime(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
