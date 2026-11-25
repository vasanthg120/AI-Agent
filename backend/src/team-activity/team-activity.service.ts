import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { ShortCache } from '../common/short-cache';
import { EmailIntelligenceService, TeamEmailMetric } from '../email-intelligence/email-intelligence.service';
import { AreaSeconds, EmployeeUsageService, PersonUsage, SignInRow, UsageDay } from '../employee-usage/employee-usage.service';
import { USAGE_AREA_LABELS, UsageArea } from '../employee-usage/usage-areas';
import { NotificationsService } from '../notifications/notifications.service';
import { PeriodRange, TeamPeriod, periodRange, previousDays, shiftDay } from './team-period';
import { ScopedBusiness, TeamPerson, TeamScope, TeamScopeService } from './team-scope.service';

type Doc = Record<string, any>;

/** What one person (or the whole team) did in the period. Every figure is counted from stored records. */
export interface ActivityCounts {
  // Deals — created / won / lost in the period, credited as the class comment says.
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  wonValue: number;
  // Won ÷ (won + lost) in the period; null when none closed.
  dealConversionPct: number | null;
  // Open deals they own right now (not tied to the period).
  openDeals: number;
  pipelineValue: number;
  // Email.
  emailsSent: number;
  emailsReceived: number;
  // Customer emails they answered in the period (in HaiVE or in Outlook).
  emailsReplied: number;
  // Still waiting for their reply, inside the first 24 hours.
  emailsNotReplied: number;
  // Went 24 hours with no reply — counted on the day the 24 hours ran out.
  emailsMissed: number;
  // Arrived in the period and still owed a reply now, however old (one per conversation).
  emailsUnanswered: number;
  // How long customers waited for the replies sent in the period, on average (written in HaiVE or Outlook).
  avgResponseSeconds: number | null;
  // Customers writing back in a conversation.
  customerReplies: number;
  // We replied in the period and asked the customer something; no answer yet.
  awaitingCustomer: number;
  // Calls.
  calls: number;
  callsMade: number;
  callsReceived: number;
  callsConnected: number;
  // Incoming phone calls nobody answered.
  callsMissed: number;
  // Outgoing phone calls the other side didn't pick up (no answer, busy, failed).
  callsUnanswered: number;
  // Phone calls that connected ÷ phone calls; incoming answered ÷ incoming.
  callConnectionRatePct: number | null;
  callAnswerRatePct: number | null;
  talkSeconds: number;
  avgCallSeconds: number | null;
  scoredCalls: number;
  // Mean AI Coach score (out of 10) of the scored calls; null when none was scored.
  avgCallScore: number | null;
  // Tasks & follow-ups: email follow-up reminders and tasks given to them
  // (on a customer, a job, a deal, or straight from Employee Activity).
  followUpsCompleted: number;
  // Not done yet, now; of which started (a task they marked "In progress") and past their day.
  followUpsPending: number;
  followUpsInProgress: number;
  followUpsOverdue: number;
  // Measured time (EmployeeUsageService): active in HaiVE or on a call, a minute counted once; and HaiVE alone.
  activeSeconds: number;
  haiveSeconds: number;
}

type ComputedField = 'avgCallSeconds' | 'avgCallScore' | 'avgResponseSeconds' | 'dealConversionPct' | 'callConnectionRatePct' | 'callAnswerRatePct';
type RawCounts = Omit<ActivityCounts, ComputedField> & { scoreSum: number; timedCalls: number; responseSecondsSum: number; timedReplies: number };

export interface TeamActivityPersonRow extends ActivityCounts {
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
  // Last time they were really active in HaiVE (any day); absent when never measured.
  lastActiveAt?: Date;
}

/** Where a source of the figures stands: how its data arrives, and when it last did. */
export interface SourceFreshness {
  businessId: string;
  businessName: string;
  key: string;
  label: string;
  // real_time: recorded as it happens · on_open: read when a page is opened (and on a timer) · nightly: read once a night.
  mode: 'real_time' | 'on_open' | 'nightly';
  status: 'ok' | 'failing' | 'never' | 'not_connected';
  lastSuccessAt?: Date;
}

/** One person's measured time, for the App usage view. */
export interface UsagePersonRow {
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
  firstAt?: Date;
  lastAt?: Date;
  lastActiveAt?: Date;
  topArea?: UsageArea;
}

/** An app people work in, and what HaiVE can tell about it: time measured, activity only, or nothing. */
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
    // Average measured time per person per day they were active.
    avgActiveSecondsPerPersonDay: number | null;
  };
  areas: { key: UsageArea; label: string; seconds: number }[];
  // Every day of the period (quiet ones as zeros), all the people shown added up.
  days: { date: string; activeSeconds: number; haiveSeconds: number; callSeconds: number; byArea: AreaSeconds; activePeople: number }[];
  people: UsagePersonRow[];
  apps: ConnectedApp[];
  // One person asked for: each day with its first and last activity and work sessions, and their sign-ins.
  person?: { days: UsageDay[]; signIns: SignInRow[] };
  // App usage has been measured since then (null: not yet in these businesses).
  measuredSince: Date | null;
  generatedAt: Date;
}

/** Deals created in the CRM that no HaiVE login is credited with, by the CRM salesperson named on them. */
export interface UnattributedDeals {
  total: number;
  byCrmOwner: { label: string; shared: boolean; count: number }[];
}

export interface TeamActivityOverview {
  team: boolean;
  acrossBusinesses: boolean;
  businesses: {
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
  }[];
  totals: ActivityCounts;
  summary: {
    employees: number;
    // People who did anything at all in the period.
    activeEmployees: number;
    // Of the customer emails owed a reply: answered / (answered + still waiting + missed).
    responseRatePct: number | null;
    followUpCompletionPct: number | null;
    // Amounts are only added up when every business shown uses one currency.
    currency: string | null;
  };
  people: TeamActivityPersonRow[];
  unattributedDeals: UnattributedDeals;
  // Who may need a hand, and why — for someone who sees the team (empty otherwise).
  attention: SupportItem[];
  // Each team (Settings → Users → Department) of each business, once anyone has one.
  departments: TeamDepartment[];
  // How each source of these figures gets its data, and when it last did.
  sources: SourceFreshness[];
  // Asked for with compare: the same totals for the period before, each business in its own timezone.
  previous?: { from: string; to: string; totals: ActivityCounts };
  generatedAt: Date;
}

/** One reason someone may need support, in a line, with the list that shows it. */
export interface SupportItem {
  personId: string;
  personName: string;
  businessId: string;
  businessName: string;
  severity: 'warning' | 'info';
  text: string;
  list?: TeamListKind;
  callFilter?: CallFilter;
}

/** A department's people added up (a business's people with no department form "No department"). */
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
  // People needing support (see SupportItem).
  needSupport: number;
}

/** A task as the lists and the To-Do page show it. */
export interface TeamTaskItem {
  id: string;
  source: 'task';
  employeeId: string;
  title: string;
  note?: string;
  dueDate?: Date;
  status: 'pending' | 'done';
  // Pending and started by its person.
  inProgress: boolean;
  startedAt?: Date;
  overdue: boolean;
  completedAt?: Date;
  dealId?: string;
  priority?: 'high';
  // Who gave it (a manager in Agent Activity, the person who added it to a customer, or the deal AI).
  givenBy?: string;
  // Where it was given: straight to the person, on a customer, a job, or by the deal AI.
  origin: 'team' | 'customer' | 'job' | 'deal';
  // Whether the person looking may move it along.
  editable: boolean;
  at: Date;
  personId?: string;
  personName?: string;
  businessId?: string;
  businessName?: string;
}

export interface GiveTaskInput {
  organizationId?: string;
  assigneeId: string;
  title: string;
  note?: string;
  dueDate?: string;
  priority?: 'high' | 'normal';
}

export interface TaskChange {
  status?: 'todo' | 'in_progress' | 'done';
  // A manager only; null clears it.
  dueDate?: string | null;
}

function toTaskItem(t: Doc, now: Date, editable: boolean): TeamTaskItem {
  const due: Date | undefined = t.dueDate instanceof Date ? t.dueDate : undefined;
  const done = t.status === 'done';
  const createdAt: Date = t.createdAt instanceof Date ? t.createdAt : now;
  return {
    id: t._id.toString(),
    source: 'task',
    employeeId: String(t.assigneeId ?? ''),
    title: t.title ?? 'Task',
    ...(typeof t.note === 'string' && t.note ? { note: t.note } : {}),
    dueDate: due,
    status: done ? 'done' : 'pending',
    inProgress: !done && t.startedAt instanceof Date,
    startedAt: !done && t.startedAt instanceof Date ? t.startedAt : undefined,
    overdue: !done && !!due && due.getTime() < now.getTime(),
    completedAt: t.completedAt instanceof Date ? t.completedAt : undefined,
    dealId: typeof t.dealId === 'string' ? t.dealId : undefined,
    ...(t.priority === 'high' ? { priority: 'high' as const } : {}),
    givenBy: t.source === 'deal-ai' ? 'Deal AI' : typeof t.createdByName === 'string' ? t.createdByName : undefined,
    origin: t.source === 'team' ? 'team' : t.source === 'deal-ai' ? 'deal' : t.jobId ? 'job' : t.customerId ? 'customer' : 'team',
    editable,
    at: done ? (t.completedAt ?? createdAt) : (due ?? createdAt),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Who may need a hand, and why, in a line each — counted from the same figures as
// the table, never guessed. Only people of the business's own staff with a login
// switched on; the Main Account owner's own records, and the person looking, are left out.
function needsSupport(people: TeamActivityPersonRow[], period: TeamPeriod, viewer: { id: string; businessId: string }): SupportItem[] {
  const staff = people.filter((p) => !p.mainAccountMember && p.active && !(p.userId === viewer.id && p.businessId === viewer.businessId));
  const items: SupportItem[] = [];
  for (const p of staff) {
    const push = (severity: SupportItem['severity'], text: string, list?: TeamListKind, callFilter?: CallFilter) =>
      items.push({ personId: p.userId, personName: p.name, businessId: p.businessId, businessName: p.businessName, severity, text, list, callFilter });
    if (p.followUpsOverdue > 0) push('warning', `${plural(p.followUpsOverdue, 'task')} past the day it was due.`, 'follow_ups');
    if (p.emailsMissed > 0) push('warning', `${plural(p.emailsMissed, 'customer email')} went 24 hours without a reply.`, 'emails_missed');
    if (p.scoredCalls >= 3 && p.avgCallScore !== null && p.avgCallScore < 5)
      push('warning', `Calls score ${p.avgCallScore}/10 on average over ${p.scoredCalls} — a coaching session could help.`, 'calls', 'scored');
    if (p.callsMissed >= 3) push('info', `${plural(p.callsMissed, 'incoming call')} nobody answered.`, 'calls', 'missed');
    // Much more open work than the others (twice their average, and at least five things).
    const others = staff.filter((o) => o !== p);
    const othersAverage = others.length ? others.reduce((s, o) => s + o.followUpsPending, 0) / others.length : null;
    if (othersAverage !== null && p.followUpsPending >= 5 && p.followUpsPending >= 2 * Math.max(othersAverage, 1))
      push('info', `${p.followUpsPending} open tasks — more than twice the others’ average; may need help or a hand-over.`, 'follow_ups');
    // Nothing at all (not judged on "today", which may have barely begun).
    if (period !== 'today' && !ACTIVITY_FIELDS.some((f) => (p as unknown as RawCounts)[f] > 0))
      push('info', 'Nothing recorded in this period — no time in HaiVE, calls, emails, deals or finished tasks.');
  }
  const rank = { warning: 0, info: 1 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.personName.localeCompare(b.personName));
}

function departmentTotals(people: TeamActivityPersonRow[], support: SupportItem[]): TeamDepartment[] {
  // Only businesses that use departments: elsewhere "No department" would be everyone, and say nothing.
  const using = new Set(people.filter((p) => !p.mainAccountMember && p.department).map((p) => p.businessId));
  const staff = people.filter((p) => !p.mainAccountMember && using.has(p.businessId));
  if (staff.length === 0) return [];
  const needing = new Set(support.map((s) => `${s.businessId}|${s.personId}`));
  const groups = new Map<string, TeamDepartment & { scoreSum: number; scored: number }>();
  for (const p of staff) {
    const key = `${p.businessId}|${p.department ?? ''}`;
    const g =
      groups.get(key) ??
      ({
        key,
        name: p.department ?? 'No department',
        businessId: p.businessId,
        businessName: p.businessName,
        people: 0,
        activePeople: 0,
        followUpsCompleted: 0,
        followUpsPending: 0,
        followUpsInProgress: 0,
        followUpsOverdue: 0,
        emailsReplied: 0,
        emailsMissed: 0,
        calls: 0,
        callsMissed: 0,
        avgCallScore: null,
        dealsWon: 0,
        needSupport: 0,
        scoreSum: 0,
        scored: 0,
      } as TeamDepartment & { scoreSum: number; scored: number });
    g.people += 1;
    if (ACTIVITY_FIELDS.some((f) => (p as unknown as RawCounts)[f] > 0)) g.activePeople += 1;
    for (const f of ['followUpsCompleted', 'followUpsPending', 'followUpsInProgress', 'followUpsOverdue', 'emailsReplied', 'emailsMissed', 'calls', 'callsMissed', 'dealsWon'] as const) g[f] += p[f];
    if (p.avgCallScore !== null) {
      g.scoreSum += p.avgCallScore * p.scoredCalls;
      g.scored += p.scoredCalls;
    }
    if (needing.has(`${p.businessId}|${p.userId}`)) g.needSupport += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ scoreSum, scored, ...g }) => ({ ...g, avgCallScore: scored ? Math.round((scoreSum / scored) * 10) / 10 : null }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName) || Number(a.name === 'No department') - Number(b.name === 'No department') || a.name.localeCompare(b.name));
}

export const TEAM_LIST_KINDS = [
  'calls',
  'emails_sent',
  'emails_received',
  'emails_replied',
  'emails_not_replied',
  'emails_missed',
  'emails_unanswered',
  'emails_customer_replies',
  'emails_awaiting_customer',
  'deals_created',
  'deals_won',
  'deals_lost',
  'pipeline',
  'follow_ups',
] as const;
export type TeamListKind = (typeof TEAM_LIST_KINDS)[number];

// missed: incoming nobody answered · unanswered: outgoing the other side didn't pick up.
export const CALL_FILTERS = ['made', 'received', 'connected', 'missed', 'unanswered', 'scored'] as const;
export type CallFilter = (typeof CALL_FILTERS)[number];

const EMAIL_METRIC: Partial<Record<TeamListKind, TeamEmailMetric>> = {
  emails_received: 'received',
  emails_replied: 'replied',
  emails_not_replied: 'pending',
  emails_missed: 'missed',
  emails_unanswered: 'unanswered',
  emails_customer_replies: 'customer_replies',
  emails_awaiting_customer: 'awaiting_customer',
};

export interface TeamActivityQuery {
  period: TeamPeriod;
  from?: string;
  to?: string;
  organizationId?: string;
  userId?: string;
  callFilter?: CallFilter;
  // Overview only: also the totals of the period before (see previousDays).
  compare?: boolean;
}

/** One call in a list: a phone call (with its recording's summary and score once processed) or a call recorded in Call Copilot. */
export interface TeamCallRow {
  id: string;
  kind: 'phone' | 'live' | 'upload';
  direction?: 'inbound' | 'outbound';
  at: Date;
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
  // The recording could not be transcribed (why, in words).
  failure?: string;
  dealId?: string;
  personId: string;
  personName: string;
  businessId: string;
  businessName: string;
}

const LIST_LIMIT = 200;
// The tasks people are given: on a customer, a job or a deal (customer-intelligence, deal-insight), or straight
// from Agent Activity (giveTask). One collection, one task system.
const TASKS = 'customer_tasks';
/** A live call left open by a closed browser tab would otherwise count for days. */
const MAX_LIVE_CALL_SECONDS = 4 * 60 * 60;
/** Daily trend points at most; a longer range is grouped by week. */
const MAX_DAILY_POINTS = 62;

/** One day (or week) of the trend. */
export interface TrendPoint {
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
  // People with measured time that day (added up over a week).
  activePeople: number;
}

function emptyPoint(): TrendPoint {
  return {
    calls: 0,
    callsMade: 0,
    callsReceived: 0,
    callsMissed: 0,
    callsUnanswered: 0,
    talkSeconds: 0,
    emailsSent: 0,
    emailsReceived: 0,
    emailsReplied: 0,
    dealsCreated: 0,
    dealsWon: 0,
    dealsLost: 0,
    wonValue: 0,
    activeSeconds: 0,
    haiveSeconds: 0,
    activePeople: 0,
  };
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  consultant: 'Sales consultant',
  agent_user: 'Team member',
};

function roleOf(person: TeamPerson): string {
  if (person.mainAccountMember) return 'Main Account';
  const role = ['owner', 'admin', 'manager', 'consultant', 'agent_user'].find((r) => person.roles.includes(r));
  return role ? ROLE_LABELS[role] : 'Member';
}

function emptyRaw(): RawCounts {
  return {
    dealsCreated: 0,
    dealsWon: 0,
    dealsLost: 0,
    wonValue: 0,
    openDeals: 0,
    pipelineValue: 0,
    emailsSent: 0,
    emailsReceived: 0,
    emailsReplied: 0,
    emailsNotReplied: 0,
    emailsMissed: 0,
    emailsUnanswered: 0,
    customerReplies: 0,
    awaitingCustomer: 0,
    calls: 0,
    callsMade: 0,
    callsReceived: 0,
    callsConnected: 0,
    callsMissed: 0,
    callsUnanswered: 0,
    talkSeconds: 0,
    scoredCalls: 0,
    followUpsCompleted: 0,
    followUpsPending: 0,
    followUpsInProgress: 0,
    followUpsOverdue: 0,
    activeSeconds: 0,
    haiveSeconds: 0,
    scoreSum: 0,
    timedCalls: 0,
    responseSecondsSum: 0,
    timedReplies: 0,
  };
}

function addInto(target: RawCounts, source: RawCounts): void {
  for (const key of Object.keys(target) as (keyof RawCounts)[]) target[key] += source[key];
}

function finish(raw: RawCounts): ActivityCounts {
  const { scoreSum, timedCalls, responseSecondsSum, timedReplies, ...rest } = raw;
  // callsMade / callsReceived are phone calls only; Call Copilot recordings have no direction.
  const phoneCalls = rest.callsMade + rest.callsReceived;
  return {
    ...rest,
    avgCallSeconds: timedCalls > 0 ? Math.round(rest.talkSeconds / timedCalls) : null,
    avgCallScore: rest.scoredCalls > 0 ? Math.round((scoreSum / rest.scoredCalls) * 10) / 10 : null,
    avgResponseSeconds: timedReplies > 0 ? Math.round(responseSecondsSum / timedReplies) : null,
    dealConversionPct: percent(rest.dealsWon, rest.dealsWon + rest.dealsLost),
    callConnectionRatePct: percent(phoneCalls - rest.callsMissed - rest.callsUnanswered, phoneCalls),
    callAnswerRatePct: percent(rest.callsReceived - rest.callsMissed, rest.callsReceived),
  };
}

const ACTIVITY_FIELDS: (keyof RawCounts)[] = [
  'dealsCreated',
  'dealsWon',
  'dealsLost',
  'emailsSent',
  'emailsReplied',
  'emailsNotReplied',
  'emailsMissed',
  'customerReplies',
  'calls',
  'scoredCalls',
  'followUpsCompleted',
  'activeSeconds',
];
/** Did anything in the period (open deals and pending follow-ups are standing state, not activity). */
const isActive = (raw: RawCounts) => ACTIVITY_FIELDS.some((f) => raw[f] > 0);

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

// Employee Activity (formerly Agent Activity) and the Dashboard's Team
// Performance: per person, what they did in a period — deals created, won and
// lost; emails sent, answered (and how fast), still waiting, unanswered and
// missed, customers' replies and our questions still unanswered; calls made,
// received, connected, missed and unanswered with talk time and AI Coach
// scores; follow-ups done and pending; measured time in HaiVE and on calls —
// and the records behind every number. Whose figures the caller sees is
// TeamScopeService's decision.
//
// Where each figure comes from:
//  - deals created / won / lost: the CRM activity log (crm_activities),
//    credited to who did it in HaiVE, else the deal's owner, else the HaiVE
//    login its CRM salesperson is linked to in Deal Assignment; created deals
//    nobody can be credited with are reported apart, by CRM salesperson;
//  - open pipeline: open deals each person owns now (crm_deals.ownerId);
//  - emails: EmailIntelligenceService's team rules (one definition everywhere);
//  - calls: Plivo/Twilio calls (made = outbound, received = inbound, connected
//    = answered, missed = not answered; talk time = their duration) plus Call
//    Copilot calls that are not a phone call's recording (a live call's length
//    counts as talk time; an uploaded file's is unknown); scores are the AI
//    Coach's, from every call it scored;
//  - follow-ups: email follow-up reminders (by mailbox) and customer tasks
//    (by assignee) — completed in the period, pending and overdue now;
//  - time: EmployeeUsageService — HaiVE in active use (measured in the
//    browser) and calls, a minute counted once; other apps report what was
//    done there, never for how long.
@Injectable()
export class TeamActivityService {
  constructor(
    @InjectConnection() private connection: Connection,
    private scopes: TeamScopeService,
    private emails: EmailIntelligenceService,
    // Tells someone they were given a task (the bell). Optional so the figures can be built without it.
    @Optional() private notifications?: NotificationsService,
    // Measured time in HaiVE and on calls; without it those figures read zero.
    @Optional() private measuredTime?: EmployeeUsageService,
  ) {}

  private col(name: string) {
    return this.connection.collection(name);
  }

  // The page asks again every minute, and several parts of it ask at once: what
  // was worked out in the last 30 seconds for the same person and question is
  // given again. Giving or moving a task clears it, so that shows at once.
  private readonly recent = new ShortCache<unknown>(30_000, 300);

  /** The same answer for the same caller and question within 30 seconds (the controller's path; tests call the methods directly). */
  cached<T>(kind: string, caller: JwtPayload, query: object, compute: () => Promise<T>): Promise<T> {
    const who = [caller.sub, caller.organizationId, caller.loginUserId ?? '', [...(caller.roles ?? [])].sort().join(','), caller.storeId ?? '', (caller.permissions ?? []).join(',')];
    return this.recent.get([kind, ...who, JSON.stringify(query)].join('|'), compute) as Promise<T>;
  }

  async overview(caller: JwtPayload, query: TeamActivityQuery, now = new Date()): Promise<TeamActivityOverview> {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const results = await Promise.all(businesses.map((b) => this.businessActivity(scope, b, query, now)));
    // The period before, worked out from each business's own days.
    const before = query.compare
      ? await Promise.all(
          results.map((r) => {
            const days = previousDays(query.period, r.range);
            return this.businessActivity(scope, r.business, { ...query, period: 'custom', from: days.from, to: days.to }, now);
          }),
        )
      : null;

    const totals = emptyRaw();
    const people: TeamActivityPersonRow[] = [];
    const unattributed = new Map<string, { label: string; shared: boolean; count: number }>();
    for (const result of results) {
      for (const row of result.people) if (!query.userId || row.userId === query.userId) people.push(row);
      for (const [key, raw] of result.raw) if (!query.userId || key === query.userId) addInto(totals, raw);
      if (!query.userId) {
        for (const item of result.unattributed) {
          const key = `${item.label}|${item.shared}`;
          const entry = unattributed.get(key) ?? { ...item, count: 0 };
          entry.count += item.count;
          unattributed.set(key, entry);
          totals.dealsCreated += item.count;
        }
      }
    }
    const byCrmOwner = [...unattributed.values()].sort((a, b) => b.count - a.count);
    const counts = finish(totals);
    const owed = counts.emailsReplied + counts.emailsNotReplied + counts.emailsMissed;
    const followUps = counts.followUpsCompleted + counts.followUpsPending;
    const currencies = new Set(results.map((r) => r.business.currency));
    const attention = scope.team && !query.userId ? needsSupport(people, query.period, { id: caller.sub, businessId: caller.organizationId }) : [];
    return {
      team: scope.team,
      acrossBusinesses: scope.acrossBusinesses,
      businesses: results.map((r) => ({
        id: r.business.id,
        name: r.business.name,
        isMain: r.business.isMain,
        isCurrent: r.business.isCurrent,
        timeZone: r.business.timeZone,
        currency: r.business.currency,
        from: r.range.from,
        to: r.range.to,
        totals: finish(r.businessTotals),
        employees: r.people.filter((p) => !p.mainAccountMember).length,
        activeEmployees: r.activeCount,
      })),
      totals: counts,
      summary: {
        employees: people.filter((p) => !p.mainAccountMember && p.active).length,
        activeEmployees: results.reduce((sum, r) => sum + r.activeCount, 0),
        responseRatePct: percent(counts.emailsReplied, owed),
        followUpCompletionPct: percent(counts.followUpsCompleted, followUps),
        currency: currencies.size === 1 ? [...currencies][0] : null,
      },
      people,
      unattributedDeals: { total: byCrmOwner.reduce((sum, r) => sum + r.count, 0), byCrmOwner },
      attention,
      departments: scope.team && !query.userId ? departmentTotals(people, attention) : [],
      sources: (await Promise.all(results.map((r) => this.sourceFreshness(r.business, r.people.map((p) => p.userId))))).flat(),
      ...(before?.length ? { previous: { from: before[0].range.from, to: before[0].range.to, totals: this.totalsOf(before, query.userId) } } : {}),
      generatedAt: now,
    };
  }

  /** Everyone's figures added up (one person's when asked), with created deals nobody is credited with. */
  private totalsOf(results: { raw: Map<string, RawCounts>; unattributed: { count: number }[] }[], userId?: string): ActivityCounts {
    const totals = emptyRaw();
    for (const result of results) {
      for (const [key, raw] of result.raw) if (!userId || key === userId) addInto(totals, raw);
      if (!userId) for (const item of result.unattributed) totals.dealsCreated += item.count;
    }
    return finish(totals);
  }

  /**
   * Where each source of a business's figures stands: calls and app usage are recorded
   * as they happen; Outlook mail is read when a page is opened and every half hour;
   * each CRM is read when a page is opened, or once a night (Hoops).
   */
  private async sourceFreshness(business: ScopedBusiness, ids: string[]): Promise<SourceFreshness[]> {
    const base = { businessId: business.id, businessName: business.name };
    const [crms, mailboxes, lastMailRead] = await Promise.all([
      this.col('crm_data_sources')
        .find({ organizationId: business.id, provider: { $ne: 'haive_native' } }, { projection: { label: 1, provider: 1, sync: 1, isDefault: 1 } })
        .sort({ isDefault: -1, 'sync.lastSuccessAt': -1 })
        .toArray(),
      ids.length ? this.col('outlook_connections').countDocuments({ userId: { $in: ids }, isActive: true }) : 0,
      ids.length
        ? this.col('email_sync_jobs')
            .find({ userId: { $in: ids }, status: { $in: ['completed', 'completed_with_errors'] } }, { projection: { completedAt: 1, createdAt: 1 } })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray()
        : [],
    ]);
    const mailAt = lastMailRead[0]?.completedAt ?? lastMailRead[0]?.createdAt;
    const out: SourceFreshness[] = [
      { ...base, key: 'calls', label: 'Calls & Call Copilot', mode: 'real_time', status: 'ok' },
      { ...base, key: 'usage', label: 'Time in HaiVE', mode: 'real_time', status: 'ok' },
      {
        ...base,
        key: 'email',
        label: 'Outlook mail',
        mode: 'on_open',
        status: mailboxes === 0 ? 'not_connected' : mailAt ? 'ok' : 'never',
        ...(mailAt instanceof Date ? { lastSuccessAt: mailAt } : {}),
      },
    ];
    // One line per CRM: the default (or last read) one when the same CRM is connected twice.
    const seen = new Set<string>();
    for (const crm of crms) {
      if (seen.has(String(crm.provider))) continue;
      seen.add(String(crm.provider));
      const sync = (crm.sync ?? {}) as Doc;
      const status: SourceFreshness['status'] = sync.lastStatus === 'error' || sync.lastStatus === 'failed' ? 'failing' : sync.lastSuccessAt ? 'ok' : 'never';
      out.push({
        ...base,
        key: `crm:${crm._id.toString()}`,
        label: String(crm.label ?? crm.provider ?? 'CRM'),
        // A CRM read only inside a nightly window (Hoops) has a sync.window.
        mode: sync.window ? 'nightly' : 'on_open',
        status,
        ...(sync.lastSuccessAt instanceof Date ? { lastSuccessAt: sync.lastSuccessAt } : {}),
      });
    }
    return out;
  }

  /** One business: every visible person's counts. */
  private async businessActivity(scope: TeamScope, business: ScopedBusiness, query: TeamActivityQuery, now: Date) {
    const range = periodRange(query.period, business.timeZone, now, { from: query.from, to: query.to });
    const everyone = await this.scopes.people(scope, business);
    const ids = everyone.map((p) => p.id);
    const raw = new Map<string, RawCounts>(ids.map((id) => [id, emptyRaw()]));
    const add = (userId: string, field: keyof RawCounts, amount: number) => {
      const entry = raw.get(userId);
      if (entry) entry[field] += amount;
    };

    const [deals, pipeline, emailCounts, sentCounts, reminders, tasks, calls, replies, usage, lastActive] = await Promise.all([
      this.dealCounts(business.id, range, everyone),
      this.pipelineCounts(business.id, ids),
      this.emails.teamEmailCounts(business.id, range.start, range.end, ids, now),
      this.emails.teamSentCounts(business.id, range.start, range.end, ids),
      this.emails.teamFollowUpCounts(business.id, range.start, range.end, ids, now),
      this.taskCounts(business.id, range, ids, now),
      this.callCounts(business.id, range, ids),
      this.emails.teamReplyStats(business.id, range.start, range.end, ids, now),
      this.measuredTime ? this.measuredTime.measure(business.id, business.timeZone, ids, range, now) : new Map<string, PersonUsage>(),
      this.measuredTime ? this.measuredTime.lastActive(business.id, ids) : new Map<string, Date>(),
    ]);

    for (const [userId, c] of deals.byPerson) {
      add(userId, 'dealsCreated', c.created);
      add(userId, 'dealsWon', c.won);
      add(userId, 'dealsLost', c.lost);
      add(userId, 'wonValue', c.wonValue);
    }
    for (const [userId, c] of pipeline) {
      add(userId, 'openDeals', c.count);
      add(userId, 'pipelineValue', c.value);
    }
    for (const [userId, c] of emailCounts) {
      add(userId, 'emailsReceived', c.received);
      add(userId, 'emailsReplied', c.replied);
      add(userId, 'emailsNotReplied', c.pending);
      add(userId, 'emailsMissed', c.missed);
      add(userId, 'emailsUnanswered', c.unanswered);
      add(userId, 'customerReplies', c.customer_replies);
      add(userId, 'awaitingCustomer', c.awaiting_customer);
    }
    for (const [userId, count] of sentCounts) add(userId, 'emailsSent', count);
    for (const [userId, r] of replies) {
      add(userId, 'responseSecondsSum', r.responseSecondsSum);
      add(userId, 'timedReplies', r.timedReplies);
    }
    for (const [userId, u] of usage) {
      add(userId, 'activeSeconds', u.activeSeconds);
      add(userId, 'haiveSeconds', u.haiveSeconds);
    }
    for (const source of [reminders, tasks]) {
      for (const [userId, c] of source) {
        add(userId, 'followUpsCompleted', c.completed);
        add(userId, 'followUpsPending', c.pending);
        // Only a task can be started; an email reminder is pending or done.
        add(userId, 'followUpsInProgress', (c as { inProgress?: number }).inProgress ?? 0);
        add(userId, 'followUpsOverdue', c.overdue);
      }
    }
    for (const [userId, c] of calls) {
      for (const key of Object.keys(c) as (keyof typeof c)[]) add(userId, key, c[key]);
    }

    // Everyone on the business's staff is listed (a quiet day shows as zeros);
    // the Main Account owner's record in a sub-account, and anyone deactivated,
    // only when they did something or hold something.
    const people: TeamActivityPersonRow[] = [];
    const businessTotals = emptyRaw();
    let activeCount = 0;
    for (const person of everyone) {
      const counts = raw.get(person.id)!;
      const holds = counts.openDeals + counts.followUpsPending > 0;
      if ((person.mainAccountMember || !person.active) && !isActive(counts) && !holds) {
        raw.delete(person.id);
        continue;
      }
      if (isActive(counts)) activeCount += 1;
      addInto(businessTotals, counts);
      people.push({
        userId: person.id,
        name: person.name,
        email: person.email,
        role: roleOf(person),
        active: person.active,
        mainAccountMember: person.mainAccountMember,
        department: person.department,
        businessId: business.id,
        businessName: business.name,
        currency: business.currency,
        ...(lastActive.has(person.id) ? { lastActiveAt: lastActive.get(person.id) } : {}),
        ...finish(counts),
      });
    }
    const unattributed = scope.team ? deals.unattributed : [];
    for (const item of unattributed) businessTotals.dealsCreated += item.count;
    return { business, range, people, raw, unattributed, businessTotals, activeCount };
  }

  // ---- deals ---------------------------------------------------------------------------

  /** Who each row of the CRM activity log counts for (see the class comment), or which CRM salesperson it names. */
  private async dealActivityRows(organizationId: string, range: PeriodRange, kinds: ('created' | 'won' | 'lost')[]) {
    const rows = await this.col('crm_activities')
      .find(
        { organizationId, entity: 'deal', kind: { $in: kinds }, occurredAt: { $gte: range.start, $lt: range.end } },
        { projection: { entityId: 1, kind: 1, actorUserId: 1, crmOwnerRef: 1, crmOwnerLabel: 1, provider: 1, occurredAt: 1, ref: 1, value: 1, byAi: 1 } },
      )
      .sort({ occurredAt: -1 })
      .toArray();
    const dealIds = [...new Set(rows.map((r) => r.entityId).filter((id): id is string => typeof id === 'string' && isValidObjectId(id)))];
    const [deals, mappings] = await Promise.all([
      dealIds.length
        ? this.col('crm_deals')
            .find(
              { _id: { $in: dealIds.map((id) => new Types.ObjectId(id)) }, organizationId },
              { projection: { name: 1, ownerId: 1, dealStatus: 1, monetaryValue: 1, externalOwnerRef: 1, externalOwnerLabel: 1, expectedClosingDate: 1 } },
            )
            .toArray()
        : [],
      this.col('crm_deal_owner_mappings').find({ organizationId }, { projection: { externalOwnerRef: 1, externalOwnerLabel: 1, linkedUserIds: 1, ownerId: 1, shared: 1 } }).toArray(),
    ]);
    const dealById = new Map<string, Doc>((deals as Doc[]).map((d): [string, Doc] => [d._id.toString(), d]));
    const mappingByRef = new Map<string, Doc>(mappings.map((m): [string, Doc] => [String(m.externalOwnerRef), m]));
    return rows.map((row) => {
      const deal = row.entityId ? dealById.get(String(row.entityId)) : undefined;
      const ref = row.crmOwnerRef ?? deal?.externalOwnerRef;
      const mapping = ref ? mappingByRef.get(String(ref)) : undefined;
      const linked: string[] = mapping?.linkedUserIds ?? [];
      // Won/lost: the deal's owner first (who closed it is rarely recorded by a CRM).
      const fromMapping = mapping && !mapping.shared ? (linked.length === 1 ? linked[0] : mapping.ownerId) : undefined;
      const creditedTo: string | undefined = row.kind === 'created' ? (row.actorUserId ?? deal?.ownerId ?? fromMapping) : (deal?.ownerId ?? row.actorUserId ?? fromMapping);
      const label: string = row.crmOwnerLabel ?? deal?.externalOwnerLabel ?? mapping?.externalOwnerLabel ?? (ref ? String(ref) : 'No salesperson named');
      return { row, deal, creditedTo: creditedTo ? String(creditedTo) : undefined, crmOwner: { label, shared: !!mapping?.shared } };
    });
  }

  private async dealCounts(organizationId: string, range: PeriodRange, everyone: TeamPerson[]) {
    const visible = new Set(everyone.map((p) => p.id));
    const byPerson = new Map<string, { created: number; won: number; lost: number; wonValue: number }>();
    const unattributed = new Map<string, { label: string; shared: boolean; count: number }>();
    for (const item of await this.dealActivityRows(organizationId, range, ['created', 'won', 'lost'])) {
      const kind = item.row.kind as 'created' | 'won' | 'lost';
      if (item.creditedTo && visible.has(item.creditedTo)) {
        const entry = byPerson.get(item.creditedTo) ?? { created: 0, won: 0, lost: 0, wonValue: 0 };
        entry[kind] += 1;
        if (kind === 'won') entry.wonValue += Number(item.deal?.monetaryValue ?? item.row.value ?? 0) || 0;
        byPerson.set(item.creditedTo, entry);
      } else if (!item.creditedTo && kind === 'created') {
        const key = `${item.crmOwner.label}|${item.crmOwner.shared}`;
        const entry = unattributed.get(key) ?? { ...item.crmOwner, count: 0 };
        entry.count += 1;
        unattributed.set(key, entry);
      }
    }
    return { byPerson, unattributed: [...unattributed.values()] };
  }

  private async pipelineCounts(organizationId: string, ids: string[]): Promise<Map<string, { count: number; value: number }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.col('crm_deals')
      .aggregate<{ _id: string; count: number; value: number }>([
        { $match: { organizationId, dealStatus: 'open', ownerId: { $in: ids } } },
        { $group: { _id: '$ownerId', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$monetaryValue', 0] } } } },
      ])
      .toArray();
    return new Map(rows.map((r) => [String(r._id), { count: r.count, value: r.value }]));
  }

  // ---- follow-ups (customer tasks; email reminders are EmailIntelligenceService's) ----------

  private async taskCounts(organizationId: string, range: PeriodRange, ids: string[], now: Date) {
    const counts = new Map<string, { completed: number; pending: number; inProgress: number; overdue: number }>();
    if (ids.length === 0) return counts;
    const rows = await this.col(TASKS)
      .aggregate<{ _id: string; completed: number; pending: number; inProgress: number; overdue: number }>([
        { $match: { organizationId, assigneeId: { $in: ids }, $or: [{ status: 'open' }, { status: 'done', completedAt: { $gte: range.start, $lt: range.end } }] } },
        {
          $group: {
            _id: '$assigneeId',
            completed: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
            // Started: an open task its person marked "In progress" (startedAt).
            inProgress: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $gt: ['$startedAt', null] }] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: [{ $ifNull: ['$dueDate', now] }, now] }] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    for (const r of rows) counts.set(String(r._id), { completed: r.completed, pending: r.pending, inProgress: r.inProgress, overdue: r.overdue });
    return counts;
  }

  // ---- calls ---------------------------------------------------------------------------

  private async linkedSessionIds(organizationId: string): Promise<Set<string>> {
    const [plivo, twilio] = await Promise.all([
      this.col('plivo_calls').distinct('sessionId', { organizationId, sessionId: { $exists: true } }),
      this.col('twilio_calls').distinct('sessionId', { organizationId, sessionId: { $exists: true } }),
    ]);
    return new Set([...plivo, ...twilio].map(String));
  }

  private async callCounts(organizationId: string, range: PeriodRange, ids: string[]) {
    type CallCounts = Pick<RawCounts, 'calls' | 'callsMade' | 'callsReceived' | 'callsConnected' | 'callsMissed' | 'callsUnanswered' | 'talkSeconds' | 'timedCalls' | 'scoredCalls' | 'scoreSum'>;
    const counts = new Map<string, CallCounts>();
    if (ids.length === 0) return counts;
    const entry = (userId: string) => {
      const existing = counts.get(userId) ?? { calls: 0, callsMade: 0, callsReceived: 0, callsConnected: 0, callsMissed: 0, callsUnanswered: 0, talkSeconds: 0, timedCalls: 0, scoredCalls: 0, scoreSum: 0 };
      counts.set(userId, existing);
      return existing;
    };
    const match = { organizationId, userId: { $in: ids }, createdAt: { $gte: range.start, $lt: range.end } };
    const answered = { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] };
    const phoneGroup = [
      { $match: match },
      {
        $group: {
          _id: '$userId',
          calls: { $sum: 1 },
          made: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 0, 1] } },
          received: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          connected: { $sum: answered },
          // Incoming and not answered; the rest not answered were outgoing.
          missed: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'inbound'] }, { $not: [{ $ifNull: ['$answeredAt', false] }] }] }, 1, 0] } },
          talk: { $sum: { $cond: [{ $ifNull: ['$answeredAt', false] }, { $ifNull: ['$durationSeconds', 0] }, 0] } },
        },
      },
    ];
    type PhoneRow = { _id: string; calls: number; made: number; received: number; connected: number; missed: number; talk: number };
    const [plivo, twilio, sessions, linked] = await Promise.all([
      this.col('plivo_calls').aggregate<PhoneRow>(phoneGroup).toArray(),
      this.col('twilio_calls').aggregate<PhoneRow>(phoneGroup).toArray(),
      this.col('call_sessions').find(match, { projection: { userId: 1, source: 1, status: 1, overallScore: 1, createdAt: 1, endedAt: 1 } }).toArray(),
      this.linkedSessionIds(organizationId),
    ]);
    for (const row of [...plivo, ...twilio]) {
      const e = entry(String(row._id));
      e.calls += row.calls;
      e.callsMade += row.made;
      e.callsReceived += row.received;
      e.callsConnected += row.connected;
      e.callsMissed += row.missed;
      e.callsUnanswered += row.calls - row.connected - row.missed;
      e.talkSeconds += row.talk;
      e.timedCalls += row.connected;
    }
    for (const s of sessions) {
      const e = entry(String(s.userId));
      if (typeof s.overallScore === 'number' && s.overallScore > 0) {
        e.scoredCalls += 1;
        e.scoreSum += s.overallScore;
      }
      if (linked.has(s._id.toString())) continue; // a phone call's recording — the call itself is counted above
      e.calls += 1;
      if (s.status !== 'error') e.callsConnected += 1;
      if (s.source === 'live' && s.endedAt instanceof Date && s.createdAt instanceof Date) {
        e.talkSeconds += Math.min(MAX_LIVE_CALL_SECONDS, Math.max(0, Math.round((s.endedAt.getTime() - s.createdAt.getTime()) / 1000)));
        e.timedCalls += 1;
      }
    }
    return counts;
  }

  // ---- trends ------------------------------------------------------------------------------

  /**
   * Day by day (week by week past two months): calls (made, received, missed,
   * unanswered), talk time, emails sent, received and answered, deals created, won
   * and lost with the value won, and measured time — for everyone the caller sees,
   * or one person. Days are each business's own; across businesses the same
   * calendar day is added up.
   */
  async trend(caller: JwtPayload, query: TeamActivityQuery, now = new Date()) {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const points = new Map<string, TrendPoint>();
    let first = '';
    let last = '';
    for (const business of businesses) {
      const range = periodRange(query.period, business.timeZone, now, { from: query.from, to: query.to });
      if (!first || range.from < first) first = range.from;
      if (!last || range.to > last) last = range.to;
      const everyone = await this.scopes.people(scope, business);
      const ids = (query.userId ? everyone.filter((p) => p.id === query.userId) : everyone).map((p) => p.id);
      if (ids.length === 0) continue;
      const point = (d: string) => {
        const existing = points.get(d) ?? emptyPoint();
        points.set(d, existing);
        return existing;
      };
      const bump = (at: unknown, field: keyof TrendPoint, amount = 1) => {
        if (at instanceof Date) point(businessDayOf(business.timeZone, at))[field] += amount;
      };
      const timeMatch = { $gte: range.start, $lt: range.end };
      const owners = { organizationId: business.id, userId: { $in: ids } };
      const phoneProjection = { createdAt: 1, answeredAt: 1, durationSeconds: 1, direction: 1 };
      const [plivo, twilio, sessions, linked, sent, replied, received, deals, usage] = await Promise.all([
        this.col('plivo_calls').find({ ...owners, createdAt: timeMatch }, { projection: phoneProjection }).toArray(),
        this.col('twilio_calls').find({ ...owners, createdAt: timeMatch }, { projection: phoneProjection }).toArray(),
        this.col('call_sessions').find({ ...owners, createdAt: timeMatch }, { projection: { createdAt: 1, endedAt: 1, source: 1 } }).toArray(),
        this.linkedSessionIds(business.id),
        this.emails.teamSentList(business.id, range.start, range.end, ids, 5000),
        this.emails.teamEmailList(business.id, 'replied', range.start, range.end, ids, 5000, now),
        this.emails.teamEmailList(business.id, 'received', range.start, range.end, ids, 5000, now),
        this.dealActivityRows(business.id, range, ['created', 'won', 'lost']),
        this.measuredTime ? this.measuredTime.measure(business.id, business.timeZone, ids, range, now) : new Map<string, PersonUsage>(),
      ]);
      for (const c of [...plivo, ...twilio]) {
        const inbound = c.direction === 'inbound';
        bump(c.createdAt, 'calls');
        bump(c.createdAt, inbound ? 'callsReceived' : 'callsMade');
        if (c.answeredAt) bump(c.createdAt, 'talkSeconds', Number(c.durationSeconds) || 0);
        else bump(c.createdAt, inbound ? 'callsMissed' : 'callsUnanswered');
      }
      for (const s of sessions) {
        if (linked.has(s._id.toString())) continue;
        bump(s.createdAt, 'calls');
        if (s.source === 'live' && s.endedAt instanceof Date) bump(s.createdAt, 'talkSeconds', Math.min(MAX_LIVE_CALL_SECONDS, Math.round((s.endedAt.getTime() - s.createdAt.getTime()) / 1000)));
      }
      for (const e of sent.items) bump(e.sentAt, 'emailsSent');
      for (const e of replied.items) bump(e.respondedAt ? new Date(e.respondedAt) : undefined, 'emailsReplied');
      for (const e of received.items) bump(e.receivedAt ? new Date(e.receivedAt) : undefined, 'emailsReceived');
      const visible = new Set(ids);
      for (const d of deals) {
        const credited = d.creditedTo ? visible.has(d.creditedTo) : scope.team && !query.userId;
        if (!credited) continue;
        const kind = d.row.kind as 'created' | 'won' | 'lost';
        bump(d.row.occurredAt, kind === 'won' ? 'dealsWon' : kind === 'lost' ? 'dealsLost' : 'dealsCreated');
        if (kind === 'won') bump(d.row.occurredAt, 'wonValue', Number(d.deal?.monetaryValue ?? d.row.value ?? 0) || 0);
      }
      for (const person of usage.values()) {
        for (const day of person.days) {
          const p = point(day.date);
          p.activeSeconds += day.activeSeconds;
          p.haiveSeconds += day.haiveSeconds;
          p.activePeople += 1;
        }
      }
    }
    // Every day of the range, quiet ones as zeros; weeks (from the first day) when the range is long.
    const days: string[] = [];
    for (let d = first; d && d <= last; d = shiftDay(d, 1)) days.push(d);
    const weekly = days.length > MAX_DAILY_POINTS;
    const series: (TrendPoint & { date: string; label: string })[] = [];
    days.forEach((d, i) => {
      const point = points.get(d) ?? emptyPoint();
      if (weekly && i % 7 !== 0) {
        const bucket = series[series.length - 1];
        for (const key of Object.keys(point) as (keyof TrendPoint)[]) bucket[key] += point[key];
        return;
      }
      series.push({ date: d, label: weekly ? `Week of ${d}` : d, ...point });
    });
    return { granularity: weekly ? 'week' : 'day', points: series };
  }

  // ---- app usage ---------------------------------------------------------------------------

  /**
   * Where people's working time went: measured time in HaiVE by part of the app and
   * on calls, day by day; each person's active days, first and last activity; the
   * other apps they work in and what can honestly be said about each — time, activity
   * only, or nothing; and for one person, each day's work sessions and their sign-ins.
   */
  async usage(caller: JwtPayload, query: TeamActivityQuery, now = new Date()): Promise<TeamUsageReport> {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const parts = await Promise.all(
      businesses.map(async (business) => {
        const range = periodRange(query.period, business.timeZone, now, { from: query.from, to: query.to });
        const everyone = await this.scopes.people(scope, business);
        const people = query.userId ? everyone.filter((p) => p.id === query.userId) : everyone;
        const ids = people.map((p) => p.id);
        const [measured, lastActive, sent, replies, deals, gmail, outlook, crms] = await Promise.all([
          this.measuredTime ? this.measuredTime.measure(business.id, business.timeZone, ids, range, now) : new Map<string, PersonUsage>(),
          this.measuredTime ? this.measuredTime.lastActive(business.id, ids) : new Map<string, Date>(),
          this.emails.teamSentCounts(business.id, range.start, range.end, ids),
          this.emails.teamReplyStats(business.id, range.start, range.end, ids, now),
          ids.length ? this.dealActivityRows(business.id, range, ['created', 'won', 'lost']) : [],
          ids.length ? this.col('gmail_connections').countDocuments({ userId: { $in: ids }, isActive: true }) : 0,
          ids.length ? this.col('outlook_connections').countDocuments({ userId: { $in: ids }, isActive: true }) : 0,
          this.col('crm_data_sources')
            .find({ organizationId: business.id, provider: { $ne: 'haive_native' } }, { projection: { label: 1, provider: 1 } })
            .toArray(),
        ]);
        return { business, range, people, ids, measured, lastActive, sent, replies, deals, gmail, outlook, crms };
      }),
    );

    // People: everyone on the staff (a quiet period shows as zeros); the Main Account
    // owner's own record and anyone switched off only when something was measured.
    const rows: UsagePersonRow[] = [];
    for (const part of parts) {
      for (const person of part.people) {
        const u = part.measured.get(person.id);
        if ((person.mainAccountMember || !person.active) && !u) continue;
        const top = u ? (Object.entries(u.byArea) as [UsageArea, number][]).sort((x, y) => y[1] - x[1])[0]?.[0] : undefined;
        rows.push({
          userId: person.id,
          name: person.name,
          role: roleOf(person),
          active: person.active,
          mainAccountMember: person.mainAccountMember,
          businessId: part.business.id,
          businessName: part.business.name,
          activeSeconds: u?.activeSeconds ?? 0,
          haiveSeconds: u?.haiveSeconds ?? 0,
          callSeconds: u?.callSeconds ?? 0,
          byArea: u?.byArea ?? {},
          activeDays: u?.activeDays ?? 0,
          avgActiveSecondsPerDay: u && u.activeDays ? Math.round(u.activeSeconds / u.activeDays) : null,
          ...(u?.firstAt ? { firstAt: u.firstAt } : {}),
          ...(u?.lastAt ? { lastAt: u.lastAt } : {}),
          ...(part.lastActive.has(person.id) ? { lastActiveAt: part.lastActive.get(person.id) } : {}),
          ...(top ? { topArea: top } : {}),
        });
      }
    }
    rows.sort((x, y) => y.activeSeconds - x.activeSeconds || x.name.localeCompare(y.name));

    // Totals, the parts of the app, and every day of the period.
    const byArea: AreaSeconds = {};
    let activeDays = 0;
    const totals = { activeSeconds: 0, haiveSeconds: 0, callSeconds: 0 };
    for (const row of rows) {
      totals.activeSeconds += row.activeSeconds;
      totals.haiveSeconds += row.haiveSeconds;
      totals.callSeconds += row.callSeconds;
      activeDays += row.activeDays;
      for (const [area, seconds] of Object.entries(row.byArea) as [UsageArea, number][]) byArea[area] = (byArea[area] ?? 0) + seconds;
    }
    const shown = new Set(rows.map((r) => `${r.businessId}|${r.userId}`));
    const dayMap = new Map<string, TeamUsageReport['days'][number]>();
    let first = '';
    let last = '';
    for (const part of parts) {
      if (!first || part.range.from < first) first = part.range.from;
      if (!last || part.range.to > last) last = part.range.to;
      for (const [userId, u] of part.measured) {
        if (!shown.has(`${part.business.id}|${userId}`)) continue;
        for (const day of u.days) {
          const entry = dayMap.get(day.date) ?? { date: day.date, activeSeconds: 0, haiveSeconds: 0, callSeconds: 0, byArea: {}, activePeople: 0 };
          entry.activeSeconds += day.activeSeconds;
          entry.haiveSeconds += day.haiveSeconds;
          entry.callSeconds += day.callSeconds;
          entry.activePeople += 1;
          for (const [area, seconds] of Object.entries(day.byArea) as [UsageArea, number][]) entry.byArea[area] = (entry.byArea[area] ?? 0) + seconds;
          dayMap.set(day.date, entry);
        }
      }
    }
    const days: TeamUsageReport['days'] = [];
    for (let d = first; d && d <= last; d = shiftDay(d, 1)) days.push(dayMap.get(d) ?? { date: d, activeSeconds: 0, haiveSeconds: 0, callSeconds: 0, byArea: {}, activePeople: 0 });

    // The apps people work in, and what HaiVE can say about each.
    const sum = <T>(items: T[], pick: (t: T) => number) => items.reduce((total, t) => total + pick(t), 0);
    const visibleIds = (part: (typeof parts)[number]) => new Set(part.ids);
    const replies = parts.flatMap((p) => [...p.replies.values()]);
    const crmCounts = new Map<string, { created: number; won: number; lost: number }>();
    const crmLabels = new Map<string, string>();
    for (const part of parts) {
      const labelOf = new Map(part.crms.map((c) => [String(c.provider), String(c.label ?? c.provider)]));
      for (const c of part.crms) crmLabels.set(String(c.label ?? c.provider), String(c.label ?? c.provider));
      const ids = visibleIds(part);
      for (const d of part.deals) {
        if (!d.creditedTo || !ids.has(d.creditedTo) || !d.row.provider || d.row.provider === 'haive') continue;
        const label = labelOf.get(String(d.row.provider)) ?? String(d.row.provider);
        const entry = crmCounts.get(label) ?? { created: 0, won: 0, lost: 0 };
        entry[d.row.kind as 'created' | 'won' | 'lost'] += 1;
        crmCounts.set(label, entry);
      }
    }
    const callCount = (label: string, count: number) => ({ label, count });
    const apps: ConnectedApp[] = [
      {
        key: 'haive',
        label: 'HaiVE',
        measure: 'time',
        connected: true,
        seconds: totals.haiveSeconds,
        activity: [],
        note: 'Measured: time with HaiVE in front and in use — a click, key press, scroll or touch in the last 2 minutes. An open tab nobody touches doesn’t count.',
      },
      {
        key: 'calls',
        label: 'Phone & Call Copilot',
        measure: 'time',
        connected: true,
        seconds: totals.callSeconds,
        activity: [],
        note: 'Measured from the calls themselves: a phone call from answer to hang-up, a live Call Copilot call from start to end.',
      },
      {
        key: 'outlook',
        label: 'Outlook',
        measure: 'activity',
        connected: sum(parts, (p) => p.outlook) > 0,
        activity: [
          callCount('Emails sent', sum(parts, (p) => sum([...p.sent.values()], (n) => n))),
          callCount('Replies written in Outlook', sum(replies, (r) => r.viaOutlook)),
          callCount('Replies written in HaiVE', sum(replies, (r) => r.viaApp)),
        ],
        note: 'Time spent in Outlook isn’t measured — only what was sent from the mailbox.',
      },
      ...[...crmLabels.keys()].map(
        (label): ConnectedApp => ({
          key: `crm:${label}`,
          label,
          measure: 'activity',
          connected: true,
          activity: [
            callCount('Deals created', crmCounts.get(label)?.created ?? 0),
            callCount('Deals won', crmCounts.get(label)?.won ?? 0),
            callCount('Deals lost', crmCounts.get(label)?.lost ?? 0),
          ],
          note: 'Time in the CRM isn’t measured — deals created, won and lost there are counted, credited through Settings → Deal Assignment.',
        }),
      ),
      {
        key: 'gmail',
        label: 'Gmail',
        measure: 'none',
        connected: sum(parts, (p) => p.gmail) > 0,
        activity: [],
        note: sum(parts, (p) => p.gmail) > 0 ? 'Connected for sending only: HaiVE doesn’t read Gmail activity, so nothing is counted.' : 'Not connected.',
      },
      {
        key: 'pos',
        label: 'POS',
        measure: 'none',
        connected: false,
        activity: [],
        note: 'No point-of-sale system is connected to HaiVE, so there is nothing to count.',
      },
    ];

    // One person: each day's first and last activity and work sessions, and their sign-ins.
    let person: TeamUsageReport['person'];
    if (query.userId) {
      const part = parts.find((p) => p.ids.includes(query.userId!));
      if (part) {
        person = {
          days: part.measured.get(query.userId)?.days ?? [],
          signIns: this.measuredTime ? await this.measuredTime.signInHistory(part.business.id, query.userId, part.range.start, part.range.end) : [],
        };
      }
    }

    return {
      team: scope.team,
      acrossBusinesses: scope.acrossBusinesses,
      businesses: parts.map((p) => ({ id: p.business.id, name: p.business.name, timeZone: p.business.timeZone, from: p.range.from, to: p.range.to })),
      totals: {
        ...totals,
        byArea,
        people: rows.filter((r) => !r.mainAccountMember && r.active).length,
        activePeople: rows.filter((r) => r.activeSeconds > 0).length,
        avgActiveSecondsPerPersonDay: activeDays ? Math.round(totals.activeSeconds / activeDays) : null,
      },
      areas: (Object.entries(byArea) as [UsageArea, number][])
        .filter(([, seconds]) => seconds > 0)
        .sort((x, y) => y[1] - x[1])
        .map(([key, seconds]) => ({ key, label: USAGE_AREA_LABELS[key], seconds })),
      days,
      people: rows,
      apps,
      ...(person ? { person } : {}),
      measuredSince: this.measuredTime ? await this.measuredTime.measuredSince(parts.map((p) => p.business.id)) : null,
      generatedAt: now,
    };
  }

  // ---- the records behind a number -------------------------------------------------------

  async list(caller: JwtPayload, kind: TeamListKind, query: TeamActivityQuery, now = new Date()) {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const parts = await Promise.all(
      businesses.map(async (business) => {
        const range = periodRange(query.period, business.timeZone, now, { from: query.from, to: query.to });
        const everyone = await this.scopes.people(scope, business);
        const people = query.userId ? everyone.filter((p) => p.id === query.userId) : everyone;
        const nameOf = new Map(everyone.map((p) => [p.id, p.name]));
        return { business, range, people, nameOf };
      }),
    );

    const items: Doc[] = [];
    let total = 0;
    for (const { business, range, people, nameOf } of parts) {
      const ids = people.map((p) => p.id);
      const who = (id: string) => ({ personId: id, personName: nameOf.get(id) ?? 'Former user', businessId: business.id, businessName: business.name, currency: business.currency });
      if (kind === 'calls') {
        const calls = this.filterCalls(await this.callList(business, range, ids, nameOf), query.callFilter);
        items.push(...calls);
        total += calls.length;
      } else if (kind === 'emails_sent') {
        const result = await this.emails.teamSentList(business.id, range.start, range.end, ids, LIST_LIMIT);
        items.push(...result.items.map((e) => ({ ...e, at: e.sentAt, ...who(e.employeeId) })));
        total += result.total;
      } else if (kind === 'deals_created' || kind === 'deals_won' || kind === 'deals_lost') {
        const which = kind === 'deals_created' ? 'created' : kind === 'deals_won' ? 'won' : 'lost';
        const deals = await this.dealList(business, range, people, which, scope.team && !query.userId && which === 'created', nameOf);
        items.push(...deals);
        total += deals.length;
      } else if (kind === 'pipeline') {
        const deals = await this.pipelineList(business, ids, nameOf);
        items.push(...deals.items);
        total += deals.total;
      } else if (kind === 'follow_ups') {
        const [reminders, tasks] = await Promise.all([this.emails.teamFollowUpList(business.id, range.start, range.end, ids, LIST_LIMIT, now), this.taskList(business, range, ids, now, (assignee) => scope.team || assignee === scope.selfId)]);
        items.push(
          ...reminders.items.map((r) => ({ ...r, source: 'email', at: r.status === 'done' ? (r.completedAt ?? r.dueDate) : r.dueDate, ...who(r.employeeId) })),
          ...tasks.map((t) => ({ ...t, ...who(t.employeeId) })),
        );
        total += reminders.total + tasks.length;
      } else {
        const metric = EMAIL_METRIC[kind]!;
        const result = await this.emails.teamEmailList(business.id, metric, range.start, range.end, ids, LIST_LIMIT, now);
        const at = (e: { respondedAt?: Date; receivedAt: Date }) => (kind === 'emails_replied' || kind === 'emails_awaiting_customer' ? (e.respondedAt ?? e.receivedAt) : e.receivedAt);
        items.push(...result.items.map((e) => ({ ...e, at: at(e), ...who(e.employeeId) })));
        total += result.total;
      }
    }
    // Follow-ups: pending before done; pending ones overdue first, then by due date, undated last. Everything else: newest first.
    const due = (item: Doc) => (item.dueDate ? new Date(item.dueDate).getTime() : Number.POSITIVE_INFINITY);
    if (kind === 'follow_ups')
      items.sort(
        (a, b) =>
          Number(a.status === 'done') - Number(b.status === 'done') ||
          (a.status === 'done' ? new Date(b.at).getTime() - new Date(a.at).getTime() : Number(!!b.overdue) - Number(!!a.overdue) || due(a) - due(b)),
      );
    else if (kind === 'pipeline') items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    else items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { kind, items: items.slice(0, LIST_LIMIT), total };
  }

  private filterCalls(calls: TeamCallRow[], filter?: CallFilter): TeamCallRow[] {
    switch (filter) {
      case 'made':
        return calls.filter((c) => c.kind === 'phone' && c.direction !== 'inbound');
      case 'received':
        return calls.filter((c) => c.kind === 'phone' && c.direction === 'inbound');
      case 'connected':
        return calls.filter((c) => c.connected);
      case 'missed':
        return calls.filter((c) => c.kind === 'phone' && c.direction === 'inbound' && !c.connected);
      case 'unanswered':
        return calls.filter((c) => c.kind === 'phone' && c.direction !== 'inbound' && !c.connected);
      case 'scored':
        return calls.filter((c) => c.score !== undefined);
      default:
        return calls;
    }
  }

  private async dealList(
    business: ScopedBusiness,
    range: PeriodRange,
    people: TeamPerson[],
    kind: 'created' | 'won' | 'lost',
    includeUncredited: boolean,
    nameOf: Map<string, string>,
  ) {
    const visible = new Set(people.map((p) => p.id));
    const rows = (await this.dealActivityRows(business.id, range, [kind])).filter((item) => (item.creditedTo ? visible.has(item.creditedTo) : includeUncredited));
    return rows.map(({ row, deal, creditedTo, crmOwner }) => ({
      id: row._id.toString(),
      dealId: deal?._id.toString() ?? (row.entityId ? String(row.entityId) : undefined),
      name: deal?.name ?? row.ref ?? 'Deal',
      value: deal?.monetaryValue ?? row.value ?? 0,
      status: deal?.dealStatus ?? (kind === 'created' ? 'open' : kind),
      provider: row.provider,
      byAi: !!row.byAi,
      at: row.occurredAt,
      crmOwner: crmOwner.label,
      sharedAccount: crmOwner.shared,
      personId: creditedTo,
      personName: creditedTo ? (nameOf.get(creditedTo) ?? 'Former user') : undefined,
      businessId: business.id,
      businessName: business.name,
      currency: business.currency,
    }));
  }

  private async pipelineList(business: ScopedBusiness, ids: string[], nameOf: Map<string, string>) {
    if (ids.length === 0) return { items: [], total: 0 };
    const match = { organizationId: business.id, dealStatus: 'open', ownerId: { $in: ids } };
    const [docs, total] = await Promise.all([
      this.col('crm_deals')
        .find(match, { projection: { name: 1, monetaryValue: 1, ownerId: 1, expectedClosingDate: 1, sourceProvider: 1, lastActivityAt: 1 } })
        .sort({ monetaryValue: -1 })
        .limit(LIST_LIMIT)
        .toArray(),
      this.col('crm_deals').countDocuments(match),
    ]);
    return {
      items: docs.map((d) => ({
        id: d._id.toString(),
        dealId: d._id.toString(),
        name: d.name ?? 'Deal',
        value: d.monetaryValue ?? 0,
        status: 'open',
        provider: d.sourceProvider,
        byAi: false,
        at: d.lastActivityAt ?? d.expectedClosingDate,
        closes: typeof d.expectedClosingDate === 'string' ? d.expectedClosingDate.slice(0, 10) : undefined,
        crmOwner: '',
        sharedAccount: false,
        personId: String(d.ownerId),
        personName: nameOf.get(String(d.ownerId)) ?? 'Former user',
        businessId: business.id,
        businessName: business.name,
        currency: business.currency,
      })),
      total,
    };
  }

  private async taskList(business: ScopedBusiness, range: PeriodRange, ids: string[], now: Date, canChange: (assigneeId: string) => boolean) {
    if (ids.length === 0) return [];
    const docs = await this.col(TASKS)
      .find(
        { organizationId: business.id, assigneeId: { $in: ids }, $or: [{ status: 'open' }, { status: 'done', completedAt: { $gte: range.start, $lt: range.end } }] },
        {
          projection: {
            title: 1,
            dueDate: 1,
            status: 1,
            assigneeId: 1,
            completedAt: 1,
            createdAt: 1,
            startedAt: 1,
            dealId: 1,
            customerId: 1,
            jobId: 1,
            source: 1,
            priority: 1,
            note: 1,
            createdByName: 1,
          },
        },
      )
      .sort({ dueDate: 1 })
      .limit(LIST_LIMIT)
      .toArray();
    return docs.map((t) => toTaskItem(t, now, canChange(String(t.assigneeId))));
  }

  // ---- giving and moving tasks ---------------------------------------------------------------

  /**
   * Gives someone a task straight from Agent Activity — the same task records as a
   * customer's or a deal's (one task system), with no customer attached. Only someone
   * who sees that person's work may: an owner or admin of their business, their store's
   * manager, or the Main Account owner.
   */
  async giveTask(caller: JwtPayload, input: GiveTaskInput, now = new Date()): Promise<TeamTaskItem> {
    this.recent.clear();
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Give the task a title.');
    const scope = await this.scopes.resolve(caller);
    const organizationId = input.organizationId && input.organizationId !== 'all' ? input.organizationId : caller.organizationId;
    const [business] = this.scopes.pick(scope, organizationId);
    if (!scope.team || !(await this.scopes.canSee(caller, business.id, input.assigneeId))) throw new ForbiddenException('You can’t give tasks to that person.');
    const person = isValidObjectId(input.assigneeId) ? await this.col('users').findOne({ _id: new Types.ObjectId(input.assigneeId), organizationId: business.id }, { projection: { name: 1, email: 1, active: 1 } }) : null;
    if (!person) throw new BadRequestException('That person isn’t part of this business.');
    if (person.active === false) throw new BadRequestException('That person’s login is switched off.');
    const due = input.dueDate ? new Date(input.dueDate) : undefined;
    if (due && Number.isNaN(due.getTime())) throw new BadRequestException('That due date isn’t a date.');
    const giver = await this.callerIn(caller, business.id);
    const doc = {
      organizationId: business.id,
      // No customer: a task of the team's own (customer-intelligence reads only tasks with keys).
      customerKeys: [],
      title,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(due ? { dueDate: due } : {}),
      priority: input.priority === 'high' ? 'high' : 'normal',
      assigneeId: person._id.toString(),
      assigneeName: person.name || person.email,
      status: 'open',
      source: 'team',
      createdBy: giver.id,
      createdByName: giver.name,
      createdAt: now,
    };
    const { insertedId } = await this.col(TASKS).insertOne(doc);
    if (doc.assigneeId !== giver.id) {
      const day = due ? ` — due ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: business.timeZone }).format(due)}` : '';
      await this.notifications
        ?.create(doc.assigneeId, { title: `New task from ${giver.name}`, description: `${title}${day}`, kind: 'system', source: 'team-tasks' }, business.id)
        .catch(() => undefined); // the task is given either way
    }
    return { ...toTaskItem({ ...doc, _id: insertedId }, now, true), personId: doc.assigneeId, personName: doc.assigneeName, businessId: business.id, businessName: business.name };
  }

  /**
   * Moves a task along: to do → in progress → done (or back). The person it is given to
   * may, and so may anyone who sees their work; a manager may also change its day.
   */
  async moveTask(caller: JwtPayload, taskId: string, change: TaskChange, now = new Date()): Promise<TeamTaskItem> {
    if (!isValidObjectId(taskId)) throw new NotFoundException('Task not found.');
    this.recent.clear();
    const scope = await this.scopes.resolve(caller);
    const task = await this.col(TASKS).findOne({ _id: new Types.ObjectId(taskId), organizationId: { $in: scope.businesses.map((b) => b.id) } });
    if (!task) throw new NotFoundException('Task not found.');
    const assigneeId = String(task.assigneeId ?? '');
    const own = task.organizationId === caller.organizationId && assigneeId === caller.sub;
    const manages = scope.team && !!assigneeId && (await this.scopes.canSee(caller, task.organizationId, assigneeId));
    if (!own && !manages) throw new ForbiddenException('Only the person it’s given to, or their manager, can change this task.');

    const set: Doc = {};
    const unset: Doc = {};
    if (change.status === 'done') Object.assign(set, { status: 'done', completedAt: now, completedBy: caller.sub });
    else if (change.status === 'in_progress') {
      Object.assign(set, { status: 'open', startedAt: task.status === 'open' && task.startedAt instanceof Date ? task.startedAt : now });
      Object.assign(unset, { completedAt: '', completedBy: '' });
    } else if (change.status === 'todo') {
      set.status = 'open';
      Object.assign(unset, { startedAt: '', completedAt: '', completedBy: '' });
    }
    if (change.dueDate !== undefined) {
      if (!manages) throw new ForbiddenException('Only their manager can change the day a task is due.');
      if (change.dueDate === null) unset.dueDate = '';
      else {
        const due = new Date(change.dueDate);
        if (Number.isNaN(due.getTime())) throw new BadRequestException('That due date isn’t a date.');
        set.dueDate = due;
      }
    }
    if (Object.keys(set).length + Object.keys(unset).length === 0) throw new BadRequestException('Nothing to change.');
    const updated = await this.col(TASKS).findOneAndUpdate(
      { _id: task._id },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Task not found.');
    const business = scope.businesses.find((b) => b.id === updated.organizationId);
    return {
      ...toTaskItem(updated, now, true),
      personId: assigneeId,
      personName: String(updated.assigneeName ?? ''),
      businessId: String(updated.organizationId),
      businessName: business?.name ?? '',
    };
  }

  /** Everything given to the caller: what is still to do (in progress first, then by day), and what they finished in the last week. */
  async myTasks(caller: JwtPayload, now = new Date()): Promise<{ items: TeamTaskItem[]; open: number; inProgress: number; overdue: number }> {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const docs = await this.col(TASKS)
      .find({ organizationId: caller.organizationId, assigneeId: caller.sub, $or: [{ status: 'open' }, { status: 'done', completedAt: { $gte: weekAgo } }] })
      .sort({ dueDate: 1, createdAt: 1 })
      .limit(LIST_LIMIT)
      .toArray();
    const items = docs.map((t) => ({ ...toTaskItem(t, now, true), personId: caller.sub, personName: String(t.assigneeName ?? ''), businessId: caller.organizationId, businessName: '' }));
    const rank = (t: TeamTaskItem) => (t.status === 'done' ? 3 : t.inProgress ? 0 : t.overdue ? 1 : 2);
    items.sort((a, b) => rank(a) - rank(b));
    const open = items.filter((t) => t.status !== 'done');
    return { items, open: open.length, inProgress: open.filter((t) => t.inProgress).length, overdue: open.filter((t) => t.overdue).length };
  }

  /** The caller's own record in a business (the Main Account owner has one in each sub-account), to sign a task with. */
  private async callerIn(caller: JwtPayload, organizationId: string): Promise<{ id: string; name: string }> {
    const self =
      organizationId === caller.organizationId
        ? isValidObjectId(caller.sub)
          ? await this.col('users').findOne({ _id: new Types.ObjectId(caller.sub) }, { projection: { name: 1, email: 1 } })
          : null
        : await this.col('users').findOne({ organizationId, linkedLoginUserId: caller.sub }, { projection: { name: 1, email: 1 } });
    return { id: self?._id.toString() ?? caller.sub, name: self?.name || self?.email || caller.email || 'Manager' };
  }

  private async callList(business: ScopedBusiness, range: PeriodRange, ids: string[], nameOf: Map<string, string>): Promise<TeamCallRow[]> {
    if (ids.length === 0) return [];
    const match = { organizationId: business.id, userId: { $in: ids }, createdAt: { $gte: range.start, $lt: range.end } };
    const phoneProjection = { userId: 1, direction: 1, customerNumber: 1, customerName: 1, createdAt: 1, answeredAt: 1, durationSeconds: 1, status: 1, sessionId: 1, dealId: 1 };
    const [plivo, twilio, sessions, linked] = await Promise.all([
      this.col('plivo_calls').find(match, { projection: phoneProjection }).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray(),
      this.col('twilio_calls').find(match, { projection: phoneProjection }).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray(),
      this.col('call_sessions')
        .find(match, {
          projection: { userId: 1, source: 1, status: 1, overallScore: 1, headline: 1, outcome: 1, createdAt: 1, endedAt: 1, errorMessage: 1, dealId: 1, originalFilename: 1 },
        })
        .sort({ createdAt: -1 })
        .limit(LIST_LIMIT)
        .toArray(),
      this.linkedSessionIds(business.id),
    ]);
    // A phone call's recording may have been processed on a later day: fetch those sessions too.
    const phoneSessionIds = [...plivo, ...twilio].map((c) => c.sessionId).filter((id): id is string => typeof id === 'string' && isValidObjectId(id));
    const extra = phoneSessionIds.length
      ? await this.col('call_sessions')
          .find({ _id: { $in: phoneSessionIds.map((id) => new Types.ObjectId(id)) }, organizationId: business.id }, { projection: { status: 1, overallScore: 1, headline: 1, outcome: 1, errorMessage: 1 } })
          .toArray()
      : [];
    const sessionById = new Map([...sessions, ...extra].map((s) => [s._id.toString(), s]));
    const base = (userId: string) => ({ personId: userId, personName: nameOf.get(userId) ?? 'Former user', businessId: business.id, businessName: business.name });
    const score = (s?: Doc) => (s && typeof s.overallScore === 'number' && s.overallScore > 0 ? s.overallScore : undefined);

    const rows: TeamCallRow[] = [];
    for (const call of [...plivo, ...twilio]) {
      const session = call.sessionId ? sessionById.get(String(call.sessionId)) : undefined;
      rows.push({
        id: call._id.toString(),
        kind: 'phone',
        direction: call.direction,
        at: call.createdAt,
        customer: call.customerName || call.customerNumber,
        customerNumber: call.customerNumber,
        durationSeconds: call.durationSeconds,
        connected: !!call.answeredAt,
        status: call.status,
        sessionId: session ? session._id.toString() : undefined,
        sessionStatus: session?.status,
        headline: session?.headline,
        outcome: session?.outcome,
        score: score(session),
        failure: session?.status === 'error' ? (session.errorMessage ?? 'The recording couldn’t be transcribed.') : undefined,
        dealId: call.dealId,
        ...base(String(call.userId)),
      });
    }
    for (const s of sessions) {
      if (linked.has(s._id.toString())) continue;
      const live = s.source === 'live';
      rows.push({
        id: s._id.toString(),
        kind: live ? 'live' : 'upload',
        at: s.createdAt,
        customer: live ? undefined : s.originalFilename,
        durationSeconds:
          live && s.endedAt instanceof Date && s.createdAt instanceof Date ? Math.min(MAX_LIVE_CALL_SECONDS, Math.round((s.endedAt.getTime() - s.createdAt.getTime()) / 1000)) : undefined,
        connected: s.status !== 'error',
        status: s.status,
        sessionId: s._id.toString(),
        sessionStatus: s.status,
        headline: s.headline,
        outcome: s.outcome,
        score: score(s),
        failure: s.status === 'error' ? (s.errorMessage ?? 'The recording couldn’t be transcribed.') : undefined,
        dealId: s.dealId,
        ...base(String(s.userId)),
      });
    }
    return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }
}
