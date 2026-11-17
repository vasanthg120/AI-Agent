import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { EmailIntelligenceService, TeamEmailMetric } from '../email-intelligence/email-intelligence.service';
import { PeriodRange, TeamPeriod, periodRange, shiftDay } from './team-period';
import { ScopedBusiness, TeamPerson, TeamScope, TeamScopeService } from './team-scope.service';

type Doc = Record<string, any>;

/** What one person (or the whole team) did in the period. Every figure is counted from stored records. */
export interface ActivityCounts {
  // Deals — created / won / lost in the period, credited as the class comment says.
  dealsCreated: number;
  dealsWon: number;
  dealsLost: number;
  wonValue: number;
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
  // Customers writing back in a conversation.
  customerReplies: number;
  // We replied in the period and asked the customer something; no answer yet.
  awaitingCustomer: number;
  // Calls.
  calls: number;
  callsMade: number;
  callsReceived: number;
  callsConnected: number;
  callsMissed: number;
  talkSeconds: number;
  avgCallSeconds: number | null;
  scoredCalls: number;
  // Mean AI Coach score (out of 10) of the scored calls; null when none was scored.
  avgCallScore: number | null;
  // Follow-ups: email follow-up reminders and customer tasks given to them.
  followUpsCompleted: number;
  followUpsPending: number;
  followUpsOverdue: number;
}

type RawCounts = Omit<ActivityCounts, 'avgCallSeconds' | 'avgCallScore'> & { scoreSum: number; timedCalls: number };

export interface TeamActivityPersonRow extends ActivityCounts {
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
  generatedAt: Date;
}

export const TEAM_LIST_KINDS = [
  'calls',
  'emails_sent',
  'emails_received',
  'emails_replied',
  'emails_not_replied',
  'emails_missed',
  'emails_customer_replies',
  'emails_awaiting_customer',
  'deals_created',
  'deals_won',
  'deals_lost',
  'pipeline',
  'follow_ups',
] as const;
export type TeamListKind = (typeof TEAM_LIST_KINDS)[number];

export const CALL_FILTERS = ['made', 'received', 'connected', 'missed', 'scored'] as const;
export type CallFilter = (typeof CALL_FILTERS)[number];

const EMAIL_METRIC: Partial<Record<TeamListKind, TeamEmailMetric>> = {
  emails_received: 'received',
  emails_replied: 'replied',
  emails_not_replied: 'pending',
  emails_missed: 'missed',
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
/** A live call left open by a closed browser tab would otherwise count for days. */
const MAX_LIVE_CALL_SECONDS = 4 * 60 * 60;
/** Daily trend points at most; a longer range is grouped by week. */
const MAX_DAILY_POINTS = 62;

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
    customerReplies: 0,
    awaitingCustomer: 0,
    calls: 0,
    callsMade: 0,
    callsReceived: 0,
    callsConnected: 0,
    callsMissed: 0,
    talkSeconds: 0,
    scoredCalls: 0,
    followUpsCompleted: 0,
    followUpsPending: 0,
    followUpsOverdue: 0,
    scoreSum: 0,
    timedCalls: 0,
  };
}

function addInto(target: RawCounts, source: RawCounts): void {
  for (const key of Object.keys(target) as (keyof RawCounts)[]) target[key] += source[key];
}

function finish(raw: RawCounts): ActivityCounts {
  const { scoreSum, timedCalls, ...rest } = raw;
  return {
    ...rest,
    avgCallSeconds: timedCalls > 0 ? Math.round(rest.talkSeconds / timedCalls) : null,
    avgCallScore: rest.scoredCalls > 0 ? Math.round((scoreSum / rest.scoredCalls) * 10) / 10 : null,
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
];
/** Did anything in the period (open deals and pending follow-ups are standing state, not activity). */
const isActive = (raw: RawCounts) => ACTIVITY_FIELDS.some((f) => raw[f] > 0);

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// Agent Activity and the Dashboard's Team Performance: per person, what they
// did in a period — deals created, won and lost; emails sent, answered, still
// waiting and missed, customers' replies and our questions still unanswered;
// calls made, received, connected and missed with talk time and AI Coach
// scores; follow-ups done and pending — and the records behind every number.
// Whose figures the caller sees is TeamScopeService's decision.
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
//    (by assignee) — completed in the period, pending and overdue now.
@Injectable()
export class TeamActivityService {
  constructor(
    @InjectConnection() private connection: Connection,
    private scopes: TeamScopeService,
    private emails: EmailIntelligenceService,
  ) {}

  private col(name: string) {
    return this.connection.collection(name);
  }

  async overview(caller: JwtPayload, query: TeamActivityQuery, now = new Date()): Promise<TeamActivityOverview> {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const results = await Promise.all(businesses.map((b) => this.businessActivity(scope, b, query, now)));

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
      generatedAt: now,
    };
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

    const [deals, pipeline, emailCounts, sentCounts, reminders, tasks, calls] = await Promise.all([
      this.dealCounts(business.id, range, everyone),
      this.pipelineCounts(business.id, ids),
      this.emails.teamEmailCounts(business.id, range.start, range.end, ids, now),
      this.emails.teamSentCounts(business.id, range.start, range.end, ids),
      this.emails.teamFollowUpCounts(business.id, range.start, range.end, ids, now),
      this.taskCounts(business.id, range, ids, now),
      this.callCounts(business.id, range, ids),
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
      add(userId, 'customerReplies', c.customer_replies);
      add(userId, 'awaitingCustomer', c.awaiting_customer);
    }
    for (const [userId, count] of sentCounts) add(userId, 'emailsSent', count);
    for (const source of [reminders, tasks]) {
      for (const [userId, c] of source) {
        add(userId, 'followUpsCompleted', c.completed);
        add(userId, 'followUpsPending', c.pending);
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
        businessId: business.id,
        businessName: business.name,
        currency: business.currency,
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
    const counts = new Map<string, { completed: number; pending: number; overdue: number }>();
    if (ids.length === 0) return counts;
    const rows = await this.col('customer_tasks')
      .aggregate<{ _id: string; completed: number; pending: number; overdue: number }>([
        { $match: { organizationId, assigneeId: { $in: ids }, $or: [{ status: 'open' }, { status: 'done', completedAt: { $gte: range.start, $lt: range.end } }] } },
        {
          $group: {
            _id: '$assigneeId',
            completed: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
            overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: [{ $ifNull: ['$dueDate', now] }, now] }] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    for (const r of rows) counts.set(String(r._id), { completed: r.completed, pending: r.pending, overdue: r.overdue });
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
    type CallCounts = Pick<RawCounts, 'calls' | 'callsMade' | 'callsReceived' | 'callsConnected' | 'callsMissed' | 'talkSeconds' | 'timedCalls' | 'scoredCalls' | 'scoreSum'>;
    const counts = new Map<string, CallCounts>();
    if (ids.length === 0) return counts;
    const entry = (userId: string) => {
      const existing = counts.get(userId) ?? { calls: 0, callsMade: 0, callsReceived: 0, callsConnected: 0, callsMissed: 0, talkSeconds: 0, timedCalls: 0, scoredCalls: 0, scoreSum: 0 };
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
          talk: { $sum: { $cond: [{ $ifNull: ['$answeredAt', false] }, { $ifNull: ['$durationSeconds', 0] }, 0] } },
        },
      },
    ];
    type PhoneRow = { _id: string; calls: number; made: number; received: number; connected: number; talk: number };
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
      e.callsMissed += row.calls - row.connected;
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
   * Day by day (week by week past two months): calls, talk time, emails sent and
   * answered, deals created and won — for everyone the caller sees, or one person.
   * Days are each business's own; across businesses the same calendar day is added up.
   */
  async trend(caller: JwtPayload, query: TeamActivityQuery, now = new Date()) {
    const scope = await this.scopes.resolve(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    type Point = { calls: number; talkSeconds: number; emailsSent: number; emailsReplied: number; dealsCreated: number; dealsWon: number };
    const points = new Map<string, Point>();
    let first = '';
    let last = '';
    for (const business of businesses) {
      const range = periodRange(query.period, business.timeZone, now, { from: query.from, to: query.to });
      if (!first || range.from < first) first = range.from;
      if (!last || range.to > last) last = range.to;
      const everyone = await this.scopes.people(scope, business);
      const ids = (query.userId ? everyone.filter((p) => p.id === query.userId) : everyone).map((p) => p.id);
      if (ids.length === 0) continue;
      const day = (at: unknown) => (at instanceof Date ? businessDayOf(business.timeZone, at) : null);
      const bump = (at: unknown, field: keyof Point, amount = 1) => {
        const d = day(at);
        if (!d) return;
        const point = points.get(d) ?? { calls: 0, talkSeconds: 0, emailsSent: 0, emailsReplied: 0, dealsCreated: 0, dealsWon: 0 };
        point[field] += amount;
        points.set(d, point);
      };
      const timeMatch = { $gte: range.start, $lt: range.end };
      const owners = { organizationId: business.id, userId: { $in: ids } };
      const [plivo, twilio, sessions, linked, sent, replied, deals] = await Promise.all([
        this.col('plivo_calls').find({ ...owners, createdAt: timeMatch }, { projection: { createdAt: 1, answeredAt: 1, durationSeconds: 1 } }).toArray(),
        this.col('twilio_calls').find({ ...owners, createdAt: timeMatch }, { projection: { createdAt: 1, answeredAt: 1, durationSeconds: 1 } }).toArray(),
        this.col('call_sessions').find({ ...owners, createdAt: timeMatch }, { projection: { createdAt: 1, endedAt: 1, source: 1 } }).toArray(),
        this.linkedSessionIds(business.id),
        this.emails.teamSentList(business.id, range.start, range.end, ids, 5000),
        this.emails.teamEmailList(business.id, 'replied', range.start, range.end, ids, 5000, now),
        this.dealActivityRows(business.id, range, ['created', 'won']),
      ]);
      for (const c of [...plivo, ...twilio]) {
        bump(c.createdAt, 'calls');
        if (c.answeredAt) bump(c.createdAt, 'talkSeconds', Number(c.durationSeconds) || 0);
      }
      for (const s of sessions) {
        if (linked.has(s._id.toString())) continue;
        bump(s.createdAt, 'calls');
        if (s.source === 'live' && s.endedAt instanceof Date) bump(s.createdAt, 'talkSeconds', Math.min(MAX_LIVE_CALL_SECONDS, Math.round((s.endedAt.getTime() - s.createdAt.getTime()) / 1000)));
      }
      for (const e of sent.items) bump(e.sentAt, 'emailsSent');
      for (const e of replied.items) bump(e.respondedAt ? new Date(e.respondedAt) : undefined, 'emailsReplied');
      const visible = new Set(ids);
      for (const d of deals) {
        const credited = d.creditedTo ? visible.has(d.creditedTo) : scope.team && !query.userId;
        if (!credited) continue;
        bump(d.row.occurredAt, d.row.kind === 'won' ? 'dealsWon' : 'dealsCreated');
      }
    }
    // Every day of the range, quiet ones as zeros; weeks (from the first day) when the range is long.
    const days: string[] = [];
    for (let d = first; d && d <= last; d = shiftDay(d, 1)) days.push(d);
    const weekly = days.length > MAX_DAILY_POINTS;
    const series: (Point & { date: string; label: string })[] = [];
    days.forEach((d, i) => {
      const point = points.get(d) ?? { calls: 0, talkSeconds: 0, emailsSent: 0, emailsReplied: 0, dealsCreated: 0, dealsWon: 0 };
      if (weekly && i % 7 !== 0) {
        const bucket = series[series.length - 1];
        for (const key of Object.keys(point) as (keyof Point)[]) bucket[key] += point[key];
        return;
      }
      series.push({ date: d, label: weekly ? `Week of ${d}` : d, ...point });
    });
    return { granularity: weekly ? 'week' : 'day', points: series };
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
        const [reminders, tasks] = await Promise.all([this.emails.teamFollowUpList(business.id, range.start, range.end, ids, LIST_LIMIT, now), this.taskList(business, range, ids, now)]);
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
        return calls.filter((c) => c.kind === 'phone' && !c.connected);
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

  private async taskList(business: ScopedBusiness, range: PeriodRange, ids: string[], now: Date) {
    if (ids.length === 0) return [];
    const docs = await this.col('customer_tasks')
      .find(
        { organizationId: business.id, assigneeId: { $in: ids }, $or: [{ status: 'open' }, { status: 'done', completedAt: { $gte: range.start, $lt: range.end } }] },
        { projection: { title: 1, dueDate: 1, status: 1, assigneeId: 1, completedAt: 1, createdAt: 1, dealId: 1 } },
      )
      .sort({ dueDate: 1 })
      .limit(LIST_LIMIT)
      .toArray();
    return docs.map((t) => {
      const due: Date | undefined = t.dueDate instanceof Date ? t.dueDate : undefined;
      const done = t.status === 'done';
      return {
        id: t._id.toString(),
        source: 'task',
        employeeId: String(t.assigneeId),
        title: t.title ?? 'Task',
        dueDate: due,
        status: done ? 'done' : 'pending',
        overdue: !done && !!due && due.getTime() < now.getTime(),
        completedAt: t.completedAt,
        dealId: typeof t.dealId === 'string' ? t.dealId : undefined,
        at: done ? (t.completedAt ?? t.createdAt) : (due ?? t.createdAt),
      };
    });
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
