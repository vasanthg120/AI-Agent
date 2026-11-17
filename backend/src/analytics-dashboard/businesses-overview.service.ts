import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { countedMonths, expectedClosingMonthsMatch } from '../crm/deal-filter.util';
import { SalesAnalyticsService } from '../crm/sales-analytics.service';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument } from '../crm/schemas/quote.schema';
import { runWithDataSourceScope } from '../data-sources/data-source-context';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { BusinessInboxView, EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { EmailIntelligenceSyncService } from '../email-intelligence/email-intelligence-sync.service';
import { hasLiveSubscription } from '../sub-accounts/subscription-access';
import { TeamActivityOverview, TeamActivityService } from '../team-activity/team-activity.service';
import { ScopedBusiness, TeamScope, TeamScopeService } from '../team-activity/team-scope.service';

type Doc = Record<string, any>;

export interface Amount {
  count: number;
  value: number;
}

/** Is a mailbox being read, is a CRM being synced. */
export interface BusinessHealthItem {
  kind: 'mailbox' | 'crm';
  label: string;
  status: 'ok' | 'failing' | 'reconnect' | 'never' | 'stale';
  // When it last worked.
  lastOkAt?: Date;
  // Failing since.
  since?: Date;
  reason?: string;
}

/** The lists behind the overview's numbers (calls and email replies use Agent Activity's own lists). */
export const BUSINESS_LIST_KINDS = ['won', 'lost', 'open', 'pipeline', 'past_due', 'quotes', 'quotes_accepted', 'emails_waiting', 'emails_overdue', 'new_enquiries'] as const;
export type BusinessListKind = (typeof BUSINESS_LIST_KINDS)[number];

export interface AttentionItem {
  businessId: string;
  businessName: string;
  severity: 'critical' | 'warning' | 'info';
  text: string;
  // What opens when it is clicked: one of the lists above, or Agent Activity's missed calls.
  list?: BusinessListKind | 'missed_calls';
}

export interface BusinessOverviewRow {
  id: string;
  name: string;
  isMain: boolean;
  isCurrent: boolean;
  currency: string;
  timeZone: string;
  // A sub-account with no live subscription: its team can only open Billing.
  locked: boolean;
  // Each business's own Dashboard figures — the same queries, in its own default CRM.
  revenue: { achieved: number; target: number | null; pct: number | null; periodGonePct: number };
  // Deals expected to close in the months counted (as the Dashboard's won / lost / open).
  deals: { won: Amount; lost: Amount; open: Amount; winRatePct: number | null };
  // Every open deal now, whatever its month; past due = its closing date has gone by.
  pipeline: { open: Amount; pastDue: Amount };
  // Quotations created in the dates chosen.
  quotes: { created: Amount; accepted: Amount };
  // The inbox now (every mailbox), and replies / missed in the period (Agent Activity's rules).
  emails: { waiting: number; overdue: number; newEnquiries: number; received: number | null; replied: number | null; missed: number | null };
  // In the period, in the business's own days (Agent Activity's rules). Null when the range is too long for them.
  calls: { total: number; connected: number; missed: number; talkSeconds: number; avgScore: number | null } | null;
  people: { total: number; active: number } | null;
  health: BusinessHealthItem[];
}

export interface BusinessesOverview {
  dateFrom: string;
  dateTo: string;
  months: { first: string; last: string };
  businesses: BusinessOverviewRow[];
  // Money is only ever added up within one currency.
  totals: {
    byCurrency: { currency: string; businesses: number; revenue: number; target: number | null; won: Amount; pipeline: Amount; pastDue: Amount }[];
    deals: { won: number; lost: number };
    emails: { waiting: number; overdue: number; newEnquiries: number; replied: number; missed: number };
    calls: { total: number; missed: number; talkSeconds: number };
  };
  attention: AttentionItem[];
  generatedAt: Date;
}

export interface BusinessListRow {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  note?: string;
  value?: number;
  currency: string;
  dealId?: string;
  at?: Date;
  businessId: string;
  businessName: string;
}

const LIST_LIMIT = 200;
const HOUR = 60 * 60 * 1000;
// A mailbox is read every half hour; one not read for this long has stopped.
const MAILBOX_STALE_MS = 6 * HOUR;
// A CRM read once a night (Hoops) is late after a day and a half; one read every few minutes, after six hours.
const NIGHTLY_CRM_STALE_MS = 36 * HOUR;
const CRM_STALE_MS = 6 * HOUR;

const amount = (row?: { count?: number; value?: number }): Amount => ({ count: row?.count ?? 0, value: row?.value ?? 0 });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

function shortDate(at: Date | undefined, timeZone: string): string {
  if (!at) return 'a while';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(at);
}

// Written as the app writes amounts (frontend utils/currency.ts): A$ for Australian dollars, never a bare "$".
const SYMBOL: Record<string, string> = { INR: '₹', AUD: 'A$', NZD: 'NZ$', USD: '$', GBP: '£', EUR: '€' };
const LOCALE: Record<string, string> = { INR: 'en-IN', AUD: 'en-AU', NZD: 'en-NZ', GBP: 'en-GB' };

function money(value: number, currency: string): string {
  const number = Math.round(value).toLocaleString(LOCALE[currency] ?? 'en-US');
  return SYMBOL[currency] ? `${SYMBOL[currency]}${number}` : `${currency} ${number}`;
}

// The Main Account owner's Dashboard: every business — the Main Account and
// each sub-account — side by side, without switching into any of them. Each
// business keeps its own workspace; this only reads.
//
// Every figure is that business's own, counted the way its own pages count it:
//  - revenue, target, deals won / lost / open and quotations: the Dashboard's
//    queries (AnalyticsDashboardService / SalesAnalyticsService), run in that
//    business's default CRM (its data-source scope), months by expected closing date;
//  - open pipeline and past due: every open deal now (the Overall Pipeline);
//  - emails waiting / over 24 hours / new enquiries: the AI Email Inbox's own
//    "needs a reply" rule, across all of the business's mailboxes;
//  - calls, email replies and missed emails in the period: Agent Activity's
//    figures (TeamActivityService), in the business's own timezone;
//  - health: each mailbox's sync (as the Inbox shows it), each CRM's last sync,
//    and whether a sub-account is locked for having no subscription.
// Who may see it is TeamScopeService's rule: the Main Account owner, signed in
// to the Main Account itself.
@Injectable()
export class BusinessesOverviewService {
  constructor(
    @InjectConnection() private connection: Connection,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    private salesAnalytics: SalesAnalyticsService,
    private dataSources: DataSourcesService,
    private emails: EmailIntelligenceService,
    private mailSync: EmailIntelligenceSyncService,
    private teamActivity: TeamActivityService,
    private scopes: TeamScopeService,
  ) {}

  private async mainScope(caller: JwtPayload): Promise<TeamScope> {
    const scope = await this.scopes.resolve(caller);
    if (!scope.acrossBusinesses) throw new ForbiddenException('Only the Main Account owner sees every business here.');
    return scope;
  }

  /** Runs `fn` as a request in that business would: its own default CRM only. */
  private async inBusiness<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    const scope = await this.dataSources.resolveScope(organizationId, undefined);
    return runWithDataSourceScope(scope, fn);
  }

  async overview(caller: JwtPayload, dateFrom: string, dateTo: string, now = new Date()): Promise<BusinessesOverview> {
    if (dateTo < dateFrom) throw new BadRequestException('The last day is before the first day.');
    const scope = await this.mainScope(caller);
    const { first, last } = countedMonths(dateFrom, dateTo);
    const [rows, activity] = await Promise.all([
      Promise.all(scope.businesses.map((b) => this.inBusiness(b.id, () => this.figures(b, dateFrom, dateTo, now)))),
      this.activity(caller, dateFrom, dateTo, now),
    ]);
    const activityOf = new Map((activity?.businesses ?? []).map((b) => [b.id, b]));
    for (const row of rows) {
      const done = activityOf.get(row.id);
      if (!done) continue;
      const t = done.totals;
      row.emails.received = t.emailsReceived;
      row.emails.replied = t.emailsReplied;
      row.emails.missed = t.emailsMissed;
      row.calls = { total: t.calls, connected: t.callsConnected, missed: t.callsMissed, talkSeconds: t.talkSeconds, avgScore: t.avgCallScore };
      row.people = { total: done.employees, active: done.activeEmployees };
    }
    return { dateFrom, dateTo, months: { first, last }, businesses: rows, totals: this.totals(rows), attention: this.attention(rows), generatedAt: now };
  }

  // Calls and email replies come from Agent Activity, for the same days; a range
  // longer than it allows (a year) leaves them out rather than failing the page.
  private async activity(caller: JwtPayload, from: string, to: string, now: Date): Promise<TeamActivityOverview | null> {
    try {
      return await this.teamActivity.overview(caller, { period: 'custom', from, to }, now);
    } catch (err) {
      if (err instanceof BadRequestException) return null;
      throw err;
    }
  }

  /** One business's own figures. Runs inside its data-source scope (see inBusiness). */
  private async figures(business: ScopedBusiness, dateFrom: string, dateTo: string, now: Date): Promise<BusinessOverviewRow> {
    const organizationId = business.id;
    const { first, last } = countedMonths(dateFrom, dateTo);
    const today = businessDayOf(business.timeZone, now);
    // As the Dashboard's quotation figures: the dates as written, whole days.
    const start = new Date(`${dateFrom}T00:00:00.000Z`);
    const end = new Date(`${dateTo}T23:59:59.999Z`);
    const closing = { $substrBytes: [{ $ifNull: ['$expectedClosingDate', ''] }, 0, 10] };
    type Group = { _id: unknown; count: number; value: number };

    const [byStatus, openNow, quotes, achievement, inbox, health, locked] = await Promise.all([
      this.dealModel
        .aggregate<Group>([
          { $match: { organizationId, expectedClosingDate: expectedClosingMonthsMatch(first, last) } },
          { $group: { _id: '$dealStatus', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$monetaryValue', 0] } } } },
        ])
        .exec(),
      this.dealModel
        .aggregate<Group>([
          { $match: { organizationId, dealStatus: 'open' } },
          // Past due: a closing date that has gone by (an open deal with no date is never "late").
          { $group: { _id: { $and: [{ $gt: [closing, ''] }, { $lt: [closing, today] }] }, count: { $sum: 1 }, value: { $sum: { $ifNull: ['$monetaryValue', 0] } } } },
        ])
        .exec(),
      this.quoteModel
        .aggregate<Group>([
          { $match: { organizationId, createdAt: { $gte: start, $lte: end } } },
          { $group: { _id: { $eq: ['$clientApprovalStatus', 'approved'] }, count: { $sum: 1 }, value: { $sum: { $ifNull: ['$quoteAmount', 0] } } } },
        ])
        .exec(),
      this.salesAnalytics.getAchievement(organizationId, 'org', undefined, first, last),
      this.emails.businessInboxCounts(organizationId, now),
      this.health(organizationId, now),
      business.isMain ? Promise.resolve(false) : hasLiveSubscription(this.connection, organizationId).then((live) => !live),
    ]);

    const status = new Map(byStatus.map((r) => [String(r._id), r]));
    const won = amount(status.get('won'));
    const lost = amount(status.get('lost'));
    const pastDue = amount(openNow.find((r) => r._id === true));
    const onTime = amount(openNow.find((r) => r._id !== true));
    const accepted = amount(quotes.find((r) => r._id === true));
    const notAccepted = amount(quotes.find((r) => r._id !== true));
    const closed = won.count + lost.count;
    return {
      id: business.id,
      name: business.name,
      isMain: business.isMain,
      isCurrent: business.isCurrent,
      currency: business.currency,
      timeZone: business.timeZone,
      locked,
      revenue: {
        achieved: achievement.achieved,
        target: achievement.targetAmount,
        pct: achievement.achievementPct,
        periodGonePct: Math.round(achievement.forecastConfidence * 100),
      },
      deals: { won, lost, open: amount(status.get('open')), winRatePct: closed > 0 ? round1((won.count / closed) * 100) : null },
      pipeline: { open: { count: pastDue.count + onTime.count, value: pastDue.value + onTime.value }, pastDue },
      quotes: { created: { count: accepted.count + notAccepted.count, value: accepted.value + notAccepted.value }, accepted },
      emails: { ...inbox, received: null, replied: null, missed: null },
      calls: null,
      people: null,
      health,
    };
  }

  /** Each active mailbox's sync (the Inbox's own health check) and each connected CRM's last sync. */
  private async health(organizationId: string, now: Date): Promise<BusinessHealthItem[]> {
    const [mailboxes, sources] = await Promise.all([
      this.connection
        .collection('outlook_connections')
        .find({ organizationId, isActive: true }, { projection: { userId: 1, email: 1, status: 1 } })
        .toArray(),
      this.connection
        .collection('crm_data_sources')
        .find({ organizationId, provider: { $ne: 'haive_native' }, status: 'active' }, { projection: { label: 1, provider: 1, sync: 1 } })
        .toArray(),
    ]);
    const mail = await Promise.all(
      mailboxes.map(async (m): Promise<BusinessHealthItem> => {
        const label = String(m.email ?? 'Mailbox');
        if (m.status === 'needs_reauth') return { kind: 'mailbox', label, status: 'reconnect', reason: 'Microsoft asked for it to be connected again.' };
        const h = await this.mailSync.mailboxHealth(String(m.userId));
        if (h.status === 'never_synced') return { kind: 'mailbox', label, status: 'never' };
        if (h.status === 'failing') return { kind: 'mailbox', label, status: 'failing', lastOkAt: h.lastSuccessAt, since: h.failingSince, reason: h.reason };
        const stale = !h.lastSuccessAt || now.getTime() - new Date(h.lastSuccessAt).getTime() > MAILBOX_STALE_MS;
        return { kind: 'mailbox', label, status: stale ? 'stale' : 'ok', lastOkAt: h.lastSuccessAt };
      }),
    );
    const crm = sources.map((s): BusinessHealthItem => {
      const sync: Doc = s.sync ?? {};
      const label = String(s.label || s.provider || 'CRM');
      const lastOkAt: Date | undefined = sync.lastSuccessAt ? new Date(sync.lastSuccessAt) : undefined;
      if (sync.enabled === false) return { kind: 'crm', label, status: 'ok', lastOkAt };
      if (sync.lastStatus === 'error') return { kind: 'crm', label, status: 'failing', lastOkAt, reason: sync.lastError ? String(sync.lastError) : undefined };
      if (!lastOkAt) return { kind: 'crm', label, status: 'never' };
      const limit = sync.window ? NIGHTLY_CRM_STALE_MS : Math.max(CRM_STALE_MS, (Number(sync.intervalMinutes) || 0) * 6 * 60_000);
      return { kind: 'crm', label, status: now.getTime() - lastOkAt.getTime() > limit ? 'stale' : 'ok', lastOkAt };
    });
    return [...mail, ...crm];
  }

  private totals(rows: BusinessOverviewRow[]): BusinessesOverview['totals'] {
    const byCurrency = new Map<string, BusinessesOverview['totals']['byCurrency'][number]>();
    const sum = (a: Amount, b: Amount): Amount => ({ count: a.count + b.count, value: a.value + b.value });
    for (const r of rows) {
      const entry = byCurrency.get(r.currency) ?? {
        currency: r.currency,
        businesses: 0,
        revenue: 0,
        target: null,
        won: amount(),
        pipeline: amount(),
        pastDue: amount(),
      };
      entry.businesses += 1;
      entry.revenue += r.revenue.achieved;
      if (r.revenue.target !== null) entry.target = (entry.target ?? 0) + r.revenue.target;
      entry.won = sum(entry.won, r.deals.won);
      entry.pipeline = sum(entry.pipeline, r.pipeline.open);
      entry.pastDue = sum(entry.pastDue, r.pipeline.pastDue);
      byCurrency.set(r.currency, entry);
    }
    const add = (pick: (r: BusinessOverviewRow) => number | null | undefined) => rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
    return {
      byCurrency: [...byCurrency.values()].sort((a, b) => b.businesses - a.businesses || a.currency.localeCompare(b.currency)),
      deals: { won: add((r) => r.deals.won.count), lost: add((r) => r.deals.lost.count) },
      emails: {
        waiting: add((r) => r.emails.waiting),
        overdue: add((r) => r.emails.overdue),
        newEnquiries: add((r) => r.emails.newEnquiries),
        replied: add((r) => r.emails.replied),
        missed: add((r) => r.emails.missed),
      },
      calls: { total: add((r) => r.calls?.total), missed: add((r) => r.calls?.missed), talkSeconds: add((r) => r.calls?.talkSeconds) },
    };
  }

  // What needs the owner's eye, worst first, in a line each — counted, never guessed.
  private attention(rows: BusinessOverviewRow[]): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const r of rows) {
      const push = (severity: AttentionItem['severity'], text: string, list?: AttentionItem['list']) =>
        items.push({ businessId: r.id, businessName: r.name, severity, text, list });
      if (r.locked) push('critical', 'No active subscription — its team can only open Billing.');
      for (const h of r.health) {
        const what = h.kind === 'mailbox' ? `Mailbox ${h.label}` : h.label;
        if (h.status === 'reconnect') push('critical', `${what} needs connecting again — no new email is being read.`);
        else if (h.status === 'failing')
          push('critical', `${what} ${h.kind === 'mailbox' ? 'isn’t being read' : 'isn’t syncing'} since ${shortDate(h.since ?? h.lastOkAt, r.timeZone)}${h.reason ? `: ${h.reason}` : '.'}`);
        else if (h.status === 'stale') push('warning', `${what} last ${h.kind === 'mailbox' ? 'read' : 'synced'} ${shortDate(h.lastOkAt, r.timeZone)}.`);
      }
      // One line for the inbox: how many wait, how many of them for over a day, how many are new enquiries.
      const { waiting, overdue, newEnquiries } = r.emails;
      if (waiting > 0) {
        const late = overdue === 0 ? '' : overdue === waiting ? (waiting === 1 ? ', over 24 hours' : ', all over 24 hours') : `, ${overdue} of them over 24 hours`;
        const asking =
          newEnquiries === 0 ? '' : newEnquiries === waiting ? (waiting === 1 ? ' — a new enquiry' : ` — all ${waiting} new enquiries`) : ` — ${plural(newEnquiries, 'new enquiry', 'new enquiries')}`;
        push(overdue > 0 ? 'warning' : 'info', `${plural(waiting, 'email')} waiting for a reply${late}${asking}.`, 'emails_waiting');
      }
      if (r.pipeline.pastDue.count > 0)
        push('warning', `${plural(r.pipeline.pastDue.count, 'open deal')} past the closing date (${money(r.pipeline.pastDue.value, r.currency)}).`, 'past_due');
      // Behind: clearly less of the target done than of the period gone (only once a tenth of it has gone).
      if (r.revenue.pct !== null && r.revenue.periodGonePct >= 10 && r.revenue.periodGonePct < 100 && r.revenue.pct + 10 < r.revenue.periodGonePct)
        push('info', `Revenue at ${r.revenue.pct}% of target with ${r.revenue.periodGonePct}% of the period gone.`, 'won');
      if (r.calls && r.calls.missed > 0) push('info', `${plural(r.calls.missed, 'missed call')} in this period.`, 'missed_calls');
    }
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.businessName.localeCompare(b.businessName));
  }

  // ---- the records behind a number --------------------------------------------------------

  async list(
    caller: JwtPayload,
    kind: BusinessListKind,
    query: { organizationId?: string; dateFrom: string; dateTo: string },
    now = new Date(),
  ): Promise<{ kind: BusinessListKind; items: BusinessListRow[]; total: number }> {
    const scope = await this.mainScope(caller);
    const businesses = this.scopes.pick(scope, query.organizationId);
    const parts = await Promise.all(businesses.map((b) => this.inBusiness(b.id, () => this.listOne(b, kind, query.dateFrom, query.dateTo, now))));
    const items = parts.flatMap((p) => p.items);
    const total = parts.reduce((s, p) => s + p.total, 0);
    if (kind.startsWith('emails') || kind === 'new_enquiries') items.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
    else if (kind === 'quotes' || kind === 'quotes_accepted') items.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
    else items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return { kind, items: items.slice(0, LIST_LIMIT), total };
  }

  private async listOne(business: ScopedBusiness, kind: BusinessListKind, dateFrom: string, dateTo: string, now: Date): Promise<{ items: BusinessListRow[]; total: number }> {
    const organizationId = business.id;
    const base = { businessId: business.id, businessName: business.name, currency: business.currency };

    if (kind === 'emails_waiting' || kind === 'emails_overdue' || kind === 'new_enquiries') {
      const view: BusinessInboxView = kind === 'emails_waiting' ? 'waiting' : kind === 'emails_overdue' ? 'overdue' : 'new_enquiries';
      const result = await this.emails.businessInboxList(organizationId, view, LIST_LIMIT, now);
      return {
        total: result.total,
        items: result.items.map((e) => ({
          ...base,
          id: e.id,
          title: e.subject,
          subtitle: e.urgent ? 'Urgent' : undefined,
          meta: `${e.from} · to ${e.mailbox} · ${waitingFor(e.receivedAt, now)}`,
          note: e.reason,
          at: e.receivedAt,
        })),
      };
    }

    if (kind === 'quotes' || kind === 'quotes_accepted') {
      const match: Doc = {
        organizationId,
        createdAt: { $gte: new Date(`${dateFrom}T00:00:00.000Z`), $lte: new Date(`${dateTo}T23:59:59.999Z`) },
        ...(kind === 'quotes_accepted' ? { clientApprovalStatus: 'approved' } : {}),
      };
      const [docs, total] = await Promise.all([
        this.quoteModel
          .find(match)
          .select({ quoteName: 1, quoteNumber: 1, quoteAmount: 1, clientApprovalStatus: 1, createdAt: 1, dealId: 1, 'clientDetails.companyName': 1, 'clientDetails.name': 1 })
          .sort({ createdAt: -1 })
          .limit(LIST_LIMIT)
          .lean<Doc[]>()
          .exec(),
        this.quoteModel.countDocuments(match).exec(),
      ]);
      return {
        total,
        items: docs.map((q) => ({
          ...base,
          id: q._id.toString(),
          title: q.quoteName || q.quoteNumber || 'Quotation',
          subtitle: q.clientApprovalStatus === 'approved' ? 'Accepted' : undefined,
          meta: [q.clientDetails?.companyName || q.clientDetails?.name, `created ${new Date(q.createdAt).toISOString().slice(0, 10)}`].filter(Boolean).join(' · '),
          value: Number(q.quoteAmount) || 0,
          dealId: typeof q.dealId === 'string' && isValidObjectId(q.dealId) ? q.dealId : undefined,
          at: q.createdAt,
        })),
      };
    }

    const { first, last } = countedMonths(dateFrom, dateTo);
    const today = businessDayOf(business.timeZone, now);
    const match: Doc =
      kind === 'pipeline'
        ? { organizationId, dealStatus: 'open' }
        : kind === 'past_due'
          ? { organizationId, dealStatus: 'open', expectedClosingDate: { $gt: '', $lt: today } }
          : { organizationId, dealStatus: kind, expectedClosingDate: expectedClosingMonthsMatch(first, last) };
    const [docs, total] = await Promise.all([
      this.dealModel
        .find(match)
        .select({ name: 1, monetaryValue: 1, dealStatus: 1, expectedClosingDate: 1 })
        .sort({ monetaryValue: -1 })
        .limit(LIST_LIMIT)
        .lean<Doc[]>()
        .exec(),
      this.dealModel.countDocuments(match).exec(),
    ]);
    return {
      total,
      items: docs.map((d) => {
        const closes = typeof d.expectedClosingDate === 'string' ? d.expectedClosingDate.slice(0, 10) : '';
        return {
          ...base,
          id: d._id.toString(),
          dealId: d._id.toString(),
          title: d.name || 'Deal',
          subtitle: d.dealStatus === 'won' ? 'Won' : d.dealStatus === 'lost' ? 'Lost' : closes && closes < today ? 'Past due' : 'Open',
          meta: closes ? `${d.dealStatus === 'open' ? 'Closes' : 'Closed'} ${closes}` : 'No closing date',
          value: Number(d.monetaryValue) || 0,
        };
      }),
    };
  }
}

function waitingFor(receivedAt: Date, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - new Date(receivedAt).getTime()) / HOUR));
  if (hours < 1) return 'just in';
  if (hours < 48) return `waiting ${hours} h`;
  return `waiting ${Math.floor(hours / 24)} days`;
}
