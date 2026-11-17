import { HttpService } from '@nestjs/axios';
import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { Connection, isValidObjectId, Types } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ReservationService } from '../billing/reservation.service';
import { isPermissionManaged } from '../common/permissions/permission.decorator';
import { TeamScope, TeamScopeService } from '../team-activity/team-scope.service';
import {
  callStats,
  CallFact,
  classifyRelationship,
  EvidenceRef,
  IntelligenceSettings,
  NextAction,
  nextBestActions,
  resolveSettings,
  scoreHealth,
  ThreeSixtyInput,
} from './customer-360';
import { CustomerDirectoryService } from './customer-directory.service';
import { EvidenceItem, IntelligenceReport, validateReport } from './customer-intelligence-report';
import { CustomerWorkspaceService } from './customer-workspace.service';

type Doc = Record<string, any>;

const SETTINGS = 'customer_intelligence_settings';
const REPORTS = 'customer_intelligence_reports';
const ACTIONS = 'customer_intelligence_actions';
const SNAPSHOTS = 'customer_health_snapshots';
const CALL_LIMIT = 200;
const TREND_POINTS = 12;
const DAY_MS = 86_400_000;

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => text(typeof v === 'object' && v ? (v as Doc).text : v)).filter(Boolean) : []);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One call with the customer, as the profile shows it. */
export interface CustomerCall extends CallFact {
  provider?: string;
  kind: 'phone' | 'live' | 'upload';
  status?: string;
  summaryPoints: string[];
  customerNeeds: string[];
  concerns: string[];
}

export type TimelineGroup = 'calls' | 'emails' | 'deals' | 'quotations' | 'payments' | 'follow_ups' | 'team';

/** The customer on a call, in a few lines (Call Copilot). */
export type CustomerSnapshot =
  | { found: false }
  | { found: true; restricted: true }
  | {
      found: true;
      restricted?: false;
      customer: { id: string; name: string; company?: string };
      currency: string;
      stage: { label: string; tone: string; reason: string };
      flags: { key: string; label: string; tone: string; reason: string }[];
      orders: number;
      revenue: number;
      openQuotes: number;
      openQuoteValue: number;
      lastContactAt?: Date;
      health: { score: number | null; band: string; label: string };
      unansweredEmails: number;
      lastCall?: { at: Date; summary?: string };
      nextSteps: string[];
    };

const GROUP_OF: Record<string, TimelineGroup> = {
  call_in: 'calls',
  call_out: 'calls',
  call_missed: 'calls',
  call_recording: 'calls',
  email_received: 'emails',
  email_sent: 'emails',
  enquiry: 'deals',
  deal: 'deals',
  contact: 'deals',
  order: 'deals',
  quotation: 'quotations',
  invoice: 'payments',
  payment: 'payments',
  follow_up: 'follow_ups',
  task: 'follow_ups',
  comment: 'team',
  file: 'team',
  status: 'team',
  job: 'deals',
};

// Customer 360° (the Customer Intelligence page): one customer seen whole —
// built on the customer directory's identity and records, plus their phone
// calls, the relationship and health HaiVE works out from them, an AI report
// that cites its evidence, and the next best actions. Reads only; the AI runs
// when someone clicks Analyse (billed), never on a page load; actions never
// send a message — they record a decision or create a follow-up task.
@Injectable()
export class Customer360Service implements OnModuleInit {
  private readonly logger = new Logger(Customer360Service.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectConnection() private connection: Connection,
    private directory: CustomerDirectoryService,
    private teamScope: TeamScopeService,
    private workspace: CustomerWorkspaceService,
    private reservations: ReservationService,
    private audit: AuditService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  async onModuleInit() {
    const ensure = (name: string, keys: Record<string, 1 | -1>, unique = false) =>
      this.connection
        .collection(name)
        .createIndex(keys, { unique })
        .catch((err) => this.logger.warn(`Index on ${name} not created: ${(err as Error).message}`));
    await Promise.all([
      ensure(SETTINGS, { organizationId: 1 }, true),
      ensure(REPORTS, { organizationId: 1, customerId: 1 }, true),
      ensure(ACTIONS, { organizationId: 1, customerId: 1, key: 1 }, true),
      ensure(SNAPSHOTS, { organizationId: 1, customerId: 1, day: 1 }, true),
      ensure('plivo_calls', { organizationId: 1, createdAt: -1 }),
      ensure('twilio_calls', { organizationId: 1, createdAt: -1 }),
    ]);
  }

  // ---- who may see which business ------------------------------------------------------------

  /** The businesses the caller may search: the Main Account owner every sub-account too; everyone else their own. */
  private async businessesFor(caller: JwtPayload, organizationId?: string) {
    const scope = await this.teamScope.resolve(caller);
    const businesses = organizationId ? scope.businesses.filter((b) => b.id === organizationId) : scope.businesses;
    if (organizationId && businesses.length === 0) throw new ForbiddenException('You don’t have access to that business’s customers.');
    return { scope, businesses };
  }

  async search(caller: JwtPayload, query: string, organizationId?: string) {
    const { businesses } = await this.businessesFor(caller, organizationId);
    // Each business searched on its own: a customer is never merged across businesses.
    const perBusiness = await Promise.all(
      businesses.map(async (b) => (await this.directory.searchIdentities(b.id, query, 20)).map((hit) => ({ ...hit, business: { id: b.id, name: b.name, isMain: b.isMain } }))),
    );
    return { businesses: businesses.map((b) => ({ id: b.id, name: b.name, isMain: b.isMain })), results: perBusiness.flat().slice(0, 40) };
  }

  // ---- settings ------------------------------------------------------------------------------------

  async settings(organizationId: string): Promise<IntelligenceSettings> {
    const saved = await this.connection.collection(SETTINGS).findOne({ organizationId });
    return resolveSettings(saved?.settings as Partial<IntelligenceSettings> | undefined);
  }

  async getSettings(caller: JwtPayload, organizationId?: string) {
    const org = organizationId ?? caller.organizationId;
    await this.businessesFor(caller, org);
    return { settings: await this.settings(org), canEdit: this.isAdmin(caller) };
  }

  async saveSettings(caller: JwtPayload, organizationId: string | undefined, body: Partial<IntelligenceSettings>) {
    const org = organizationId ?? caller.organizationId;
    await this.businessesFor(caller, org);
    if (!this.isAdmin(caller)) throw new ForbiddenException('Only the business owner or an admin can change how customers are scored.');
    const settings = resolveSettings(body);
    await this.connection
      .collection(SETTINGS)
      .updateOne({ organizationId: org }, { $set: { organizationId: org, settings, updatedAt: new Date(), updatedBy: caller.sub } }, { upsert: true });
    return { settings, canEdit: true };
  }

  private isAdmin(caller: JwtPayload) {
    return caller.roles.includes('owner') || caller.roles.includes('admin');
  }

  // ---- calls ---------------------------------------------------------------------------------------

  /** Their phone calls (matched on their numbers, or made for one of their deals) that the caller may see, with each call's report. */
  private async calls(caller: JwtPayload, scope: TeamScope, organizationId: string, phones: string[], dealIds: string[]): Promise<CustomerCall[]> {
    const or: Doc[] = [];
    if (phones.length) or.push({ customerNumber: { $regex: `(${phones.map(escapeRegex).join('|')})$` } });
    if (dealIds.length) or.push({ dealId: { $in: dealIds } });
    const phoneCalls: Doc[] = or.length
      ? (
          await Promise.all(
            ['plivo_calls', 'twilio_calls'].map(async (name) =>
              (await this.connection.collection(name).find({ organizationId, $or: or }).sort({ createdAt: -1 }).limit(CALL_LIMIT).toArray()).map(
                (doc): Doc => ({ ...doc, provider: name.startsWith('plivo') ? 'plivo' : 'twilio' }),
              ),
            ),
          )
        ).flat()
      : [];
    const sessionIds = phoneCalls.map((c) => text(c.sessionId)).filter((id) => isValidObjectId(id));
    const sessionOr: Doc[] = [
      ...(sessionIds.length ? [{ _id: { $in: sessionIds.map((id) => new Types.ObjectId(id)) } }] : []),
      ...(dealIds.length ? [{ dealId: { $in: dealIds } }, { contactId: { $in: dealIds } }] : []),
    ];
    const sessions: Doc[] = sessionOr.length
      ? await this.connection
          .collection('call_sessions')
          .find({ organizationId, $or: sessionOr })
          .project({ transcript: 0, events: 0, recommendations: 0, voiceScripts: 0, contextBlob: 0 })
          .limit(CALL_LIMIT)
          .toArray()
      : [];
    const sessionById = new Map(sessions.map((s) => [s._id.toString(), s]));

    // Only the calls of people the caller may see (team rules: owners/admins all, managers their store, others their own).
    const storeOf = new Map<string, string | undefined>();
    if (scope.storeId) {
      const ids = [...new Set([...phoneCalls.map((c) => text(c.userId)), ...sessions.map((s) => text(s.userId))])].filter((id) => isValidObjectId(id));
      const users = await this.connection
        .collection('users')
        .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { storeId: 1 } })
        .toArray();
      for (const u of users) storeOf.set(u._id.toString(), u.storeId);
    }
    const visible = (userId: string) => userId === caller.sub || (scope.team && (!scope.storeId || storeOf.get(userId) === scope.storeId));

    const userIds = [...new Set([...phoneCalls.map((c) => text(c.userId)), ...sessions.map((s) => text(s.userId))])].filter((id) => isValidObjectId(id));
    const names = new Map(
      (
        await this.connection
          .collection('users')
          .find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } }, { projection: { name: 1, email: 1 } })
          .toArray()
      ).map((u) => [u._id.toString(), text(u.name) || text(u.email) || 'Team member']),
    );

    const fromSession = (s: Doc | undefined) => {
      if (!s) return {};
      const moments: Doc[] = Array.isArray(s.keyMoments) ? s.keyMoments : [];
      return {
        sessionId: s._id.toString(),
        headline: text(s.headline) || undefined,
        sentiment: text(s.sentiment) || undefined,
        score: typeof s.overallScore === 'number' ? s.overallScore : undefined,
        outcome: text(s.outcome) || undefined,
        followUps: (Array.isArray(s.followUpActions) ? (s.followUpActions as Doc[]) : []).filter((f) => f.owner !== 'customer').map((f) => text(f.text)).filter(Boolean),
        riskSignals: moments.filter((m) => m.momentType === 'risk_signal').map((m) => text(m.text)).filter(Boolean),
        buyingSignals: moments.filter((m) => m.momentType === 'buying_signal').map((m) => text(m.text)).filter(Boolean),
        summaryPoints: strings(s.summaryPoints).length ? strings(s.summaryPoints) : text(s.summary) ? [text(s.summary)] : [],
        customerNeeds: strings(s.customerNeeds),
        concerns: strings(s.concernsRaised),
      };
    };

    const linked = new Set<string>();
    const calls: CustomerCall[] = [];
    for (const c of phoneCalls) {
      const userId = text(c.userId);
      if (!visible(userId)) continue;
      const session = sessionById.get(text(c.sessionId));
      if (session) linked.add(session._id.toString());
      const direction = c.direction === 'inbound' ? 'inbound' : 'outbound';
      const duration = typeof c.durationSeconds === 'number' ? c.durationSeconds : typeof c.recordingDurationSeconds === 'number' ? c.recordingDurationSeconds : undefined;
      const connected = !!c.answeredAt || (duration ?? 0) > 0;
      calls.push({
        id: c._id.toString(),
        at: asDate(c.createdAt) ?? new Date(0),
        direction,
        connected,
        missed: direction === 'inbound' && !connected,
        durationSeconds: duration,
        employee: names.get(userId),
        provider: c.provider,
        kind: 'phone',
        status: text(c.status) || undefined,
        followUps: [],
        riskSignals: [],
        buyingSignals: [],
        summaryPoints: [],
        customerNeeds: [],
        concerns: [],
        ...fromSession(session),
      });
    }
    // Recorded or uploaded calls tied to one of their deals without a phone-call record.
    for (const s of sessions) {
      if (linked.has(s._id.toString()) || !visible(text(s.userId))) continue;
      const startedAt = asDate(s.createdAt) ?? new Date(0);
      const endedAt = asDate(s.endedAt);
      calls.push({
        id: s._id.toString(),
        at: startedAt,
        direction: 'unknown',
        connected: true,
        missed: false,
        durationSeconds: endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : undefined,
        employee: names.get(text(s.userId)),
        kind: s.source === 'upload' ? 'upload' : 'live',
        status: text(s.status) || undefined,
        followUps: [],
        riskSignals: [],
        buyingSignals: [],
        summaryPoints: [],
        customerNeeds: [],
        concerns: [],
        ...fromSession(s),
      });
    }
    return calls.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  // ---- the profile ---------------------------------------------------------------------------------

  private async gather(caller: JwtPayload, organizationId: string, customerId: string) {
    const { scope, businesses } = await this.businessesFor(caller, organizationId);
    const basis = await this.directory.intelligenceBasis(organizationId, customerId);
    const dealIds = [...new Set(basis.deals.flatMap((d) => [d.id, d.externalId]).filter((id): id is string => !!id))];
    const [settings, calls] = await Promise.all([this.settings(organizationId), this.calls(caller, scope, organizationId, basis.phones, dealIds)]);
    return { business: businesses[0], basis, settings, calls };
  }

  private input(g: Awaited<ReturnType<Customer360Service['gather']>>, aiSentiment?: ThreeSixtyInput['aiSentiment']): ThreeSixtyInput {
    const { basis, settings, calls } = g;
    const d = basis.detail;
    const now = new Date();
    const callTimes = calls.map((c) => c.at.getTime()).filter((t) => t > 0);
    const lastActivity = Math.max(basis.lastActivityAt?.getTime() ?? 0, ...callTimes, 0);
    const firstSeen = Math.min(basis.firstSeenAt?.getTime() ?? Infinity, ...callTimes);
    const unanswered = d.emails.filter((e) => e.direction === 'received' && e.needsReply);
    return {
      now,
      settings,
      firstSeenAt: Number.isFinite(firstSeen) ? new Date(firstSeen) : undefined,
      lastActivityAt: lastActivity > 0 ? new Date(lastActivity) : undefined,
      orders: {
        count: d.orders.count,
        totalValue: d.orders.totalValue,
        lastOrderAt: d.orders.lastOrderAt,
        firstOrderAt: undefined,
      },
      peerRevenues: basis.peerRevenues,
      deals: {
        open: basis.deals.filter((x) => x.status === 'open').length,
        won: basis.deals.filter((x) => x.status === 'won').length,
        lost: basis.deals.filter((x) => x.status === 'lost').length,
      },
      quotes: d.quotations.map((q) => ({ id: q.id, number: q.number, date: q.date, state: q.state, amount: q.amount })),
      paymentsTracked: d.payment.status !== 'not_recorded',
      payment: d.payment,
      invoices: d.invoiceList.map((i) => ({ id: i.id, number: i.number, amount: i.amount, outstanding: i.outstanding, overdue: i.overdue, dueDate: i.dueDate })),
      email: {
        received: d.mail.received,
        sent: d.mail.sent,
        unanswered: d.mail.unanswered,
        lastReceivedAt: d.mail.lastReceivedAt,
        lastSentAt: d.mail.lastSentAt,
        oldestUnansweredAt: unanswered.length ? new Date(Math.min(...unanswered.map((e) => new Date(e.at).getTime()))) : undefined,
        weReplyInHours: d.weReplyInHours,
      },
      unansweredEmails: unanswered.map((e) => ({ id: e.id, subject: e.subject, at: new Date(e.at) })),
      calls,
      followUps: [
        ...d.followUps.map((f) => ({ title: f.title, dueDate: new Date(f.dueDate), status: f.status })),
        ...(d.followUp.count > d.followUps.filter((f) => f.status === 'pending').length && d.followUp.nextAt
          ? [{ title: d.followUp.nextTitle ?? 'Follow-up', dueDate: new Date(d.followUp.nextAt), status: 'pending' as const }]
          : []),
      ],
      inquiry: { open: d.inquiries.open, actioned: d.inquiries.actioned, latestAt: d.inquiries.latestAt },
      crmLost: d.crm.status === 'lost',
      aiSentiment,
    };
  }

  /** The records the AI is shown, numbered — what its report may cite. No contact details: it needs the story, not the address book. */
  private evidence(g: Awaited<ReturnType<Customer360Service['gather']>>): { items: (EvidenceItem & { details: Doc })[]; hash: string } {
    const d = g.basis.detail;
    const items: (EvidenceItem & { details: Doc })[] = [];
    const add = (kind: EvidenceItem['kind'], refId: string | undefined, label: string, at: Date | undefined, details: Doc) =>
      items.push({ id: `E${items.length + 1}`, kind, refId, label, at, details });
    if (d.inquiry) add('inquiry', undefined, `Enquiry${d.inquiry.receivedAt ? ` of ${new Date(d.inquiry.receivedAt).toISOString().slice(0, 10)}` : ''}`, d.inquiry.receivedAt, { whatTheyWrote: d.inquiry.fields, channel: d.inquiry.channel });
    for (const deal of g.basis.deals.slice(0, 15))
      add('deal', deal.id, deal.name ?? 'Deal', deal.createdAt, { status: deal.status, value: deal.value, lostReason: deal.lostReason, closedAt: deal.closedAt, expectedClosingDate: deal.expectedClosingDate });
    for (const q of d.quotations.slice(0, 15))
      add('quotation', q.id, `Quotation ${q.number ?? q.name ?? ''}`.trim(), q.date, { status: q.stateLabel, amount: q.amount, validUntil: q.expiresAt });
    for (const i of d.invoiceList.slice(0, 15))
      add('invoice', i.id, `Invoice ${i.number ?? ''}`.trim(), i.date, { status: i.statusLabel, amount: i.amount, paid: i.paid, outstanding: i.outstanding, overdue: i.overdue });
    for (const e of d.emails.slice(0, 25))
      add('email', e.id, e.subject || '(no subject)', new Date(e.at), { direction: e.direction === 'received' ? 'from the customer' : 'from us', waitingForOurReply: e.needsReply });
    for (const c of g.calls.slice(0, 15))
      add('call', c.sessionId ?? c.id, c.headline ?? `Call of ${c.at.toISOString().slice(0, 10)}`, c.at, {
        direction: c.direction,
        connected: c.connected,
        missed: c.missed,
        minutes: c.durationSeconds ? Math.round(c.durationSeconds / 60) : undefined,
        summary: c.summaryPoints,
        customerNeeds: c.customerNeeds,
        concerns: c.concerns,
        buyingSignals: c.buyingSignals,
        riskSignals: c.riskSignals,
        sentiment: c.sentiment,
        outcome: c.outcome,
        promisedFollowUps: c.followUps,
        callScore: c.score,
      });
    const hash = createHash('sha256')
      .update(JSON.stringify(items.map(({ id, kind, refId, label, at, details }) => [id, kind, refId, label, at, details])))
      .digest('hex')
      .slice(0, 24);
    return { items, hash };
  }

  private async savedReport(organizationId: string, customerId: string, hash: string) {
    const saved = await this.connection.collection(REPORTS).findOne({ organizationId, customerId });
    if (!saved) return null;
    return {
      report: saved.result as IntelligenceReport,
      evidence: (saved.evidence ?? []) as EvidenceItem[],
      generatedAt: saved.generatedAt as Date,
      stale: saved.factsHash !== hash,
    };
  }

  async profile(caller: JwtPayload, organizationId: string, customerId: string) {
    const g = await this.gather(caller, organizationId, customerId);
    const { items, hash } = this.evidence(g);
    const saved = await this.savedReport(organizationId, customerId, hash);
    const aiSentiment = saved && saved.report.sentiment.overall !== 'unknown' ? saved.report.sentiment.overall : undefined;
    const input = this.input(g, aiSentiment);
    const relationship = classifyRelationship(input);
    const health = scoreHealth(input);
    const stats = callStats(g.calls);
    const now = input.now;

    // A daily snapshot of the score, to show how it moves.
    const day = now.toISOString().slice(0, 10);
    if (health.score !== null) {
      await this.connection
        .collection(SNAPSHOTS)
        .updateOne(
          { organizationId, customerId, day },
          { $set: { organizationId, customerId, day, score: health.score, band: health.band, parts: health.parts.map(({ key, score }) => ({ key, score })), at: now } },
          { upsert: true },
        )
        .catch(() => undefined);
    }
    const trend = (
      await this.connection.collection(SNAPSHOTS).find({ organizationId, customerId }).sort({ day: -1 }).limit(TREND_POINTS).toArray()
    )
      .reverse()
      .map((s) => ({ day: text(s.day), score: Number(s.score) }));

    // Actions: the rules' and the AI report's, each with what the team decided about it.
    const evidenceById = new Map((saved?.evidence ?? []).map((e) => [e.id, e]));
    const aiActions: NextAction[] = (saved && !saved.stale ? saved.report.recommendations : []).map((r) => ({
      key: `ai:${createHash('sha1').update(r.action.toLowerCase()).digest('hex').slice(0, 12)}`,
      action: r.action,
      reason: r.reason,
      evidence: r.evidence
        .map((id) => evidenceById.get(id))
        .filter((e): e is EvidenceItem => !!e)
        .map((e): EvidenceRef => ({ kind: e.kind, id: e.refId, label: e.label })),
      priority: r.priority,
      deadline: r.deadline,
      outcome: r.outcome,
      source: 'ai',
    }));
    const decisions = await this.connection.collection(ACTIONS).find({ organizationId, customerId }).toArray();
    const decided = new Map(decisions.map((x) => [text(x.key), x]));
    const allActions = [...nextBestActions(input, relationship), ...aiActions].map((a) => {
      const decision = decided.get(a.key);
      return {
        ...a,
        status: (decision ? text(decision.status) : 'open') as 'open' | 'accepted' | 'dismissed' | 'follow_up',
        decidedAt: asDate(decision?.at),
        decidedBy: text(decision?.byName) || undefined,
        taskId: text(decision?.taskId) || undefined,
      };
    });

    const timeline = [
      ...g.basis.detail.timeline.map((e) => ({ ...e, group: GROUP_OF[e.kind] ?? 'team' })),
      ...g.calls.map((c) => ({
        at: c.at,
        kind: c.missed ? 'call_missed' : c.direction === 'inbound' ? 'call_in' : c.direction === 'outbound' ? 'call_out' : 'call_recording',
        group: 'calls' as TimelineGroup,
        title: c.missed
          ? 'Missed call from the customer'
          : `${c.direction === 'inbound' ? 'Incoming call' : c.direction === 'outbound' ? 'Outgoing call' : 'Recorded call'}${c.employee ? ` · ${c.employee}` : ''}${
              c.connected ? '' : ' · not connected'
            }`,
        detail: c.headline ?? (c.durationSeconds ? `${Math.max(1, Math.round(c.durationSeconds / 60))} min` : undefined),
        ref: c.sessionId ? { kind: 'call', id: c.sessionId } : undefined,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // Opening a customer's calls and recordings is sensitive: who looked is recorded.
    await this.audit.log({
      userId: caller.sub,
      organizationId,
      method: 'GET',
      route: '/customer-intelligence/profile',
      statusCode: 200,
      durationMs: 0,
      action: 'customer_360_view',
      metadata: { customerId, calls: g.calls.length, viewerOrganizationId: caller.organizationId },
    });

    const d = g.basis.detail;
    return {
      business: { id: g.business.id, name: g.business.name, isMain: g.business.isMain, currency: d.currency },
      customer: {
        id: d.id,
        name: d.name,
        company: d.company,
        email: d.email,
        phone: d.phone,
        people: d.people,
        address: d.address,
        addresses: d.addresses,
        website: d.website,
        industryType: d.industryType,
        sources: d.sources,
        owner: d.repName ?? d.owner,
        archived: d.archived,
        crmStatus: d.crm.label,
        inquiry: d.inquiry,
      },
      identity: { ...g.basis.identity, possibleDuplicates: g.basis.possibleDuplicates },
      relationship,
      health: { ...health, trend },
      revenue: {
        lifetimeRevenue: d.orders.totalValue,
        completedOrders: d.orders.count,
        lastOrderAt: d.orders.lastOrderAt,
        openQuotes: d.quotes.openCount,
        openQuoteValue: d.quotes.openValue,
        paymentsTracked: input.paymentsTracked,
        billed: d.payment.billed,
        paid: d.payment.paid,
        outstanding: d.payment.outstanding,
        overdue: d.payment.overdueAmount,
        paymentStatus: d.payment.label,
      },
      deals: g.basis.deals,
      quotations: d.quotations,
      invoices: d.invoiceList,
      documents: d.documents,
      email: {
        ...d.mail,
        weReplyInHours: d.weReplyInHours,
        customerRepliesInDays: d.customerRepliesInDays,
        responseRate: d.mail.received > 0 ? Math.round(((d.mail.received - d.mail.unanswered) / d.mail.received) * 100) : null,
        list: d.emails,
        followUps: d.followUps,
      },
      calls: { stats, list: g.calls },
      timeline,
      actions: allActions.filter((a) => a.status !== 'dismissed'),
      dismissedActions: allActions.filter((a) => a.status === 'dismissed').length,
      report: saved
        ? {
            ...saved.report,
            evidence: saved.evidence,
            generatedAt: saved.generatedAt,
            stale: saved.stale,
          }
        : null,
      gaps: d.gaps,
      sources: g.basis.sources,
      analysedFrom: { emails: d.emails.length, calls: g.calls.length, deals: g.basis.deals.length, quotations: d.quotations.length, invoices: d.invoiceList.length, evidence: items.length },
      generatedAt: now,
    };
  }

  // ---- the AI report ------------------------------------------------------------------------------------

  async analyze(caller: JwtPayload, organizationId: string, customerId: string, refresh: boolean) {
    const g = await this.gather(caller, organizationId, customerId);
    const { items, hash } = this.evidence(g);
    const saved = await this.savedReport(organizationId, customerId, hash);
    if (saved && !saved.stale && !refresh) return { ...saved.report, evidence: saved.evidence, generatedAt: saved.generatedAt, stale: false };
    if (items.length === 0) throw new BadRequestException('There is nothing recorded about this customer yet for the AI to read.');

    const input = this.input(g);
    const relationship = classifyRelationship(input);
    const health = scoreHealth(input);
    const d = g.basis.detail;
    const facts = {
      today: input.now.toISOString().slice(0, 10),
      currency: d.currency,
      customer: { name: d.name, company: d.company ?? null, crmStatus: d.crm.label },
      relationship: relationship.badges.map((b) => ({ label: b.label, why: b.reasons })),
      purchaseHistory: relationship.purchaseHistory,
      relationshipHistory: relationship.relationshipHistory,
      health: { score: health.score, band: health.bandLabel },
      payments: input.paymentsTracked ? { billed: d.payment.billed, paid: d.payment.paid, outstanding: d.payment.outstanding, overdue: d.payment.overdueAmount } : 'not recorded',
      evidence: items.map(({ id, kind, label, at, details }) => ({ id, kind, label, date: at ? at.toISOString().slice(0, 10) : null, ...details })),
    };

    // Billed like every other button-triggered AI action: reserve first, settle on success, release on failure.
    const requestId = randomUUID();
    await this.reservations.reserve(this.reservations.resolveTenantKey(organizationId, caller.sub), caller.sub, requestId, 'customer-intelligence');
    let raw: unknown;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post(`${this.pythonAgentUrl}/customers/intelligence`, { ...facts, request_id: requestId }, { headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 }),
      );
      await this.reservations.settle(requestId);
      raw = data;
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Customer intelligence report failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The AI report couldn’t be written right now. Please try again in a minute.');
    }
    const evidence: EvidenceItem[] = items.map(({ id, kind, refId, label, at }) => ({ id, kind, refId, label, at }));
    const report = validateReport(raw, evidence);
    const generatedAt = new Date();
    await this.connection
      .collection(REPORTS)
      .updateOne(
        { organizationId, customerId },
        { $set: { organizationId, customerId, result: report, evidence, factsHash: hash, generatedAt, generatedBy: caller.sub } },
        { upsert: true },
      );
    return { ...report, evidence, generatedAt, stale: false };
  }

  // ---- decisions on next actions ------------------------------------------------------------------------

  /**
   * Accept, dismiss or turn into a follow-up task one suggested action. Never sends
   * anything. Recording the same decision twice changes nothing (one per action key);
   * a follow-up is created once.
   */
  async decide(
    caller: JwtPayload,
    organizationId: string,
    customerId: string,
    body: { key: string; decision: 'accepted' | 'dismissed' | 'follow_up' | 'open'; title?: string; dueDate?: string; assigneeId?: string },
  ) {
    await this.businessesFor(caller, organizationId);
    const key = text(body.key).slice(0, 200);
    if (!key) throw new BadRequestException('Which action?');
    const collection = this.connection.collection(ACTIONS);
    const existing = await collection.findOne({ organizationId, customerId, key });
    if (body.decision === 'open') {
      if (existing?.taskId) throw new BadRequestException('A follow-up was already created for this action — close it in Tasks instead.');
      await collection.deleteOne({ organizationId, customerId, key });
      return { key, status: 'open' };
    }
    if (body.decision === 'follow_up' && existing?.taskId) return { key, status: 'follow_up', taskId: text(existing.taskId) };
    const byName = text(caller.email) || 'Team member';
    let taskId: string | undefined;
    if (body.decision === 'follow_up') {
      const title = text(body.title).slice(0, 200);
      if (!title) throw new BadRequestException('Give the follow-up a title.');
      // The task belongs to the customer's business (a Main Account owner may be looking at a sub-account).
      const task = await this.workspace.addTask({ ...caller, organizationId }, customerId, { title, dueDate: body.dueDate, assigneeId: body.assigneeId });
      taskId = (task as { id?: string }).id;
    }
    await collection.updateOne(
      { organizationId, customerId, key },
      { $set: { organizationId, customerId, key, status: body.decision, by: caller.sub, byName, at: new Date(), ...(taskId ? { taskId } : {}) } },
      { upsert: true },
    );
    return { key, status: body.decision, ...(taskId ? { taskId } : {}) };
  }

  // ---- the short version, for Call Copilot ---------------------------------------------------------

  /**
   * Who the customer on a call is, in a few lines: are they new or a repeat buyer,
   * what they bought, what is open, when we last spoke, and the next one or two
   * things to do. Found by the call's deal, else the number dialled. Same rule as
   * the Dialer's contact search: owners, admins, managers and anyone given
   * Customers see every customer; everyone else only the customers they are rep of.
   */
  async snapshot(caller: JwtPayload, ref: { dealId?: string; phone?: string }): Promise<CustomerSnapshot> {
    const organizationId = caller.organizationId;
    const found = await this.directory.customerForCall(organizationId, ref);
    if (!found) return { found: false };
    const seesEveryone =
      caller.roles.some((role) => role === 'owner' || role === 'admin' || role === 'manager') ||
      (isPermissionManaged(caller) && !!caller.permissions?.includes('customers:view'));
    if (!seesEveryone && found.repUserId !== caller.sub) return { found: true, restricted: true };

    const g = await this.gather(caller, organizationId, found.id);
    const input = this.input(g);
    const relationship = classifyRelationship(input);
    const health = scoreHealth(input);
    const steps = nextBestActions(input, relationship);
    const d = g.basis.detail;
    const lastCall = g.calls.find((c) => c.connected && (c.headline || c.summaryPoints.length));
    const [stage, ...flags] = relationship.badges;
    return {
      found: true,
      customer: { id: d.id, name: d.name, company: d.company },
      currency: d.currency,
      stage: { label: stage.label, tone: stage.tone, reason: stage.reasons[0] ?? '' },
      flags: flags.map((b) => ({ key: b.key, label: b.label, tone: b.tone, reason: b.reasons[0] ?? '' })),
      orders: d.orders.count,
      revenue: d.orders.totalValue,
      openQuotes: d.quotes.openCount,
      openQuoteValue: d.quotes.openValue,
      lastContactAt: input.lastActivityAt,
      health: { score: health.score, band: health.band, label: health.bandLabel },
      unansweredEmails: d.mail.unanswered,
      lastCall: lastCall ? { at: lastCall.at, summary: lastCall.headline ?? lastCall.summaryPoints[0] } : undefined,
      nextSteps: steps.slice(0, 2).map((a) => a.action),
    };
  }

  /** Health snapshots, oldest first (also used by tests). */
  async healthTrend(organizationId: string, customerId: string, since = new Date(Date.now() - 365 * DAY_MS)): Promise<Doc[]> {
    return this.connection
      .collection(SNAPSHOTS)
      .find({ organizationId, customerId, at: { $gte: since } })
      .sort({ day: 1 })
      .toArray();
  }
}
