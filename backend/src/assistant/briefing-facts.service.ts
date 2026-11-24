import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { BusinessesOverviewService } from '../analytics-dashboard/businesses-overview.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { TeamActivityService } from '../team-activity/team-activity.service';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { DEFAULT_QUESTIONS, Metric } from './conversation-settings';

export { DEFAULT_QUESTIONS };

/** What this person sees: every business, one business's team, a store's team, or their own work. */
export type Sees = 'all_businesses' | 'business' | 'store_team' | 'own_work';

export interface BriefingFacts {
  person: { firstName: string; sees: Sees };
  now: { date: string; weekday: string; timeOfDay: 'morning' | 'afternoon' | 'evening'; timeZone: string };
  language: string;
  // Owners and admins: each business they see, its own figures in its own currency.
  businesses: BusinessFacts[];
  // What needs attention, worst first (counted, not guessed).
  attention: string[];
  // Owners, admins and managers: who on the team may need a hand.
  teamNeedsSupport: { person: string; ref: string; business?: string; reason: string }[];
  // Who Haive may suggest giving a task to (owners, admins, managers): these people, by ref, and "me".
  actionPeople: { ref: string; name: string; business?: string }[];
  // Server-side only (never sent to the AI): what each ref stands for.
  actionTargets?: Record<string, { personId: string; businessId: string; name: string; timeZone: string }>;
  me: {
    tasks?: { open: number; inProgress: number; overdue: number; dueToday: number };
    // Someone who sees only their own work: their mailbox and calls.
    emailsWaitingForMyReply?: number;
    myCallsToday?: { total: number; missed: number };
  };
  questions: string[];
  // Why Haive is speaking now, when it reached out (a scheduled briefing, an alert): lead with it.
  focus?: string;
  // Never talk about these: this business doesn't record them.
  notTracked: string[];
}

// Each part is left out when the person chose not to follow it (AI Conversations settings → metrics).
export interface BusinessFacts {
  name: string;
  currency: string;
  revenueThisMonth?: { actual: number; target: number | null; percentOfTarget: number | null; monthGonePercent: number; projectedMonthEnd: number | null };
  dealsThisMonth?: { won: number; wonValue: number; lost: number };
  openPipeline?: { deals: number; value: number; pastClosingDate: number; pastClosingDateValue: number };
  quotesAwaitingDecision?: { count: number; value: number };
  dealsClosingThisWeek?: { name: string; value: number; closes: string }[];
  inbox?: { waitingForReply: number; waitingOver24h: number; newEnquiries: number };
  callsToday?: { total: number; missed: number } | null;
  problems?: string[];
}

export interface BriefingOptions {
  language?: string;
  questions?: string[];
  // What the person follows; anything missing counts as followed.
  metrics?: Partial<Record<Metric, boolean>>;
}

// Which metric an attention line belongs to (a lapsed subscription is always said).
const ATTENTION_METRIC: Record<string, Metric | null> = { subscription: null, sync: 'syncHealth', emails: 'emails', pipeline: 'pipeline', revenue: 'revenue', calls: 'calls' };

const round = (n: number) => Math.round(n);

// The facts Haive's spoken briefing is written from — the business's own data, the
// same figures its Dashboard, Inbox and Agent Activity show, limited to what this
// person may see (TeamScopeService):
//  - an owner or admin: each business they see (the Main Account owner: every one);
//  - a store manager: their store team's support lines;
//  - everyone: their own tasks; someone who sees only their own work, their mailbox and calls.
// Nothing here is an estimate except projectedMonthEnd, which says so.
@Injectable()
export class BriefingFactsService {
  constructor(
    @InjectConnection() private connection: Connection,
    private scopes: TeamScopeService,
    private businesses: BusinessesOverviewService,
    private activity: TeamActivityService,
    private emails: EmailIntelligenceService,
  ) {}

  async build(caller: JwtPayload, options: BriefingOptions = {}, now = new Date()): Promise<BriefingFacts> {
    const follows = (m: Metric) => options.metrics?.[m] !== false;
    const scope = await this.scopes.resolve(caller);
    const current = scope.businesses.find((b) => b.isCurrent) ?? scope.businesses[0];
    const timeZone = current.timeZone;
    const today = businessDayOf(timeZone, now);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(now);
    const sees: Sees = scope.acrossBusinesses ? 'all_businesses' : scope.team ? (scope.storeId ? 'store_team' : 'business') : 'own_work';

    const [overview, extras, week, todayActivity, myTasks, self] = await Promise.all([
      this.businesses.forBriefing(caller, `${today.slice(0, 8)}01`, today, now),
      this.businesses.briefingExtras(caller, now),
      scope.team && follows('team') ? this.activity.overview(caller, { period: 'last7' }, now) : Promise.resolve(null),
      follows('calls') ? this.activity.overview(caller, { period: 'today' }, now) : Promise.resolve(null),
      follows('tasks') ? this.activity.myTasks(caller, now) : Promise.resolve(null),
      isValidObjectId(caller.sub) ? this.connection.collection('users').findOne({ _id: new Types.ObjectId(caller.sub) }, { projection: { name: 1, email: 1 } }) : null,
    ]);

    const callsToday = new Map((todayActivity?.businesses ?? []).map((b) => [b.id, { total: b.totals.calls, missed: b.totals.callsMissed }]));
    const businesses: BusinessFacts[] = (overview?.businesses ?? [])
      .map((b): BusinessFacts => {
        const extra = extras.get(b.id);
        const gone = b.revenue.periodGonePct;
        return {
          name: b.name,
          currency: b.currency,
          revenueThisMonth: {
            actual: round(b.revenue.achieved),
            target: b.revenue.target === null ? null : round(b.revenue.target),
            percentOfTarget: b.revenue.pct,
            monthGonePercent: gone,
            // A straight-line projection from the month so far — a forecast, and labelled one.
            projectedMonthEnd: gone >= 10 && gone < 100 ? round((b.revenue.achieved / gone) * 100) : null,
          },
          dealsThisMonth: { won: b.deals.won.count, wonValue: round(b.deals.won.value), lost: b.deals.lost.count },
          openPipeline: { deals: b.pipeline.open.count, value: round(b.pipeline.open.value), pastClosingDate: b.pipeline.pastDue.count, pastClosingDateValue: round(b.pipeline.pastDue.value) },
          quotesAwaitingDecision: { count: extra?.quotesAwaitingDecision.count ?? 0, value: round(extra?.quotesAwaitingDecision.value ?? 0) },
          dealsClosingThisWeek: (extra?.closingThisWeek ?? []).map((d) => ({ ...d, value: round(d.value) })),
          inbox: { waitingForReply: b.emails.waiting, waitingOver24h: b.emails.overdue, newEnquiries: b.emails.newEnquiries },
          callsToday: callsToday.get(b.id) ?? null,
          problems: b.health.filter((h) => h.status !== 'ok').map((h) => `${h.kind === 'mailbox' ? 'Mailbox' : 'CRM'} ${h.label}: ${h.status === 'reconnect' ? 'needs connecting again' : h.status === 'never' ? 'never synced' : h.status === 'stale' ? 'sync is late' : 'not syncing'}`),
        };
      })
      // A business with nothing in it (a Main Account that only holds sub-accounts) says nothing useful.
      .filter((b) => b.revenueThisMonth!.actual || b.openPipeline!.deals || b.inbox!.waitingForReply || b.callsToday?.total || b.quotesAwaitingDecision!.count || b.problems!.length)
      .map((b) => this.onlyFollowed(b, follows));

    const me: BriefingFacts['me'] = {};
    if (myTasks) {
      const dueToday = myTasks.items.filter((t) => t.status !== 'done' && t.dueDate && businessDayOf(timeZone, new Date(t.dueDate)) === today).length;
      me.tasks = { open: myTasks.open, inProgress: myTasks.inProgress, overdue: myTasks.overdue, dueToday };
    }
    if (!scope.team) {
      if (follows('emails')) me.emailsWaitingForMyReply = (await this.emails.businessInboxCounts(caller.organizationId, now, caller.sub)).waiting;
      const mine = todayActivity?.people[0];
      if (mine) me.myCallsToday = { total: mine.calls, missed: mine.callsMissed };
    }

    // People Haive may suggest a task for — only someone who can give tasks (a team view): those who need support, and themselves.
    const support = (week?.attention ?? []).slice(0, 5);
    const refOf = new Map<string, string>();
    const actionTargets: NonNullable<BriefingFacts['actionTargets']> = {};
    const businessName = new Map(scope.businesses.map((b) => [b.id, b.name]));
    const zoneOf = new Map(scope.businesses.map((b) => [b.id, b.timeZone]));
    for (const a of support) {
      if (refOf.has(a.personId)) continue;
      const ref = `p${refOf.size + 1}`;
      refOf.set(a.personId, ref);
      actionTargets[ref] = { personId: a.personId, businessId: a.businessId, name: a.personName, timeZone: zoneOf.get(a.businessId) ?? timeZone };
    }
    if (scope.team) actionTargets.me = { personId: caller.sub, businessId: caller.organizationId, name: 'you', timeZone };
    else for (const k of Object.keys(actionTargets)) delete actionTargets[k];

    const name = String(self?.name || self?.email || caller.email || '').trim();
    return {
      person: { firstName: name.split(/\s+/)[0] || 'there', sees },
      now: { date: today, weekday, timeOfDay: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening', timeZone },
      language: options.language ?? 'en',
      businesses,
      attention: (overview?.attention ?? [])
        .filter((a) => {
          const metric = ATTENTION_METRIC[a.topic];
          return !metric || follows(metric);
        })
        .slice(0, 6)
        .map((a) => `${a.businessName}: ${a.text}`),
      teamNeedsSupport: support.map((a) => ({ person: a.personName, ref: refOf.get(a.personId)!, ...(scope.acrossBusinesses ? { business: a.businessName } : {}), reason: a.text })),
      actionPeople: Object.entries(actionTargets).map(([ref, t]) => ({ ref, name: ref === 'me' ? 'yourself' : t.name, ...(scope.acrossBusinesses && ref !== 'me' ? { business: businessName.get(t.businessId) } : {}) })),
      actionTargets,
      me,
      // The person's own questions (an empty list: they want none suggested).
      questions: (options.questions ?? DEFAULT_QUESTIONS).slice(0, 12),
      notTracked: ['payments', 'invoices and money owed'],
    };
  }

  /** A business's facts without the parts this person doesn't follow. */
  private onlyFollowed(b: BusinessFacts, follows: (m: Metric) => boolean): BusinessFacts {
    const out: BusinessFacts = { name: b.name, currency: b.currency };
    if (follows('revenue')) Object.assign(out, { revenueThisMonth: b.revenueThisMonth, dealsThisMonth: b.dealsThisMonth });
    if (follows('pipeline')) Object.assign(out, { openPipeline: b.openPipeline, dealsClosingThisWeek: b.dealsClosingThisWeek });
    if (follows('quotations')) out.quotesAwaitingDecision = b.quotesAwaitingDecision;
    if (follows('emails')) out.inbox = b.inbox;
    if (follows('calls')) out.callsToday = b.callsToday;
    if (follows('syncHealth')) out.problems = b.problems;
    return out;
  }
}
