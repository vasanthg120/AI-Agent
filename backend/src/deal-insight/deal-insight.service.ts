import { HttpService } from '@nestjs/axios';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { Connection, Types, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ReservationService } from '../billing/reservation.service';
import { businessDayOf } from '../common/business-day';
import { deriveRespondedInfo, deriveResponseStatus } from '../email-intelligence/email-response-state';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { ASSIGNMENT_HISTORY_COLLECTION } from '../crm/deals.service';
import { DealHealth, dealHealth } from './deal-health';

type Doc = Record<string, any>;

export const LEAD_STATUSES = [
  'new_lead',
  'contacted',
  'interested',
  'negotiation',
  'quote_sent',
  'awaiting_response',
  'follow_up_required',
  'payment_pending',
  'won',
  'lost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** The AI's reading of a deal (python-agent DEAL_BRIEF_TOOL). Never written back over the CRM's own stage. */
export interface DealBrief {
  statusLabel: string;
  // Inferred from the records; the CRM's own stage stays as it is.
  leadStatus: LeadStatus;
  leadStatusReason: string;
  // What the records say, apart from what the AI concludes from them.
  observedFacts: string[];
  inferences: string[];
  emailSummary: string;
  emailInsights: { questions: string[]; commitments: string[]; pricing: string[]; objections: string[]; competitors: string[] };
  crmOverview: string;
  recommendations: { action: string; why: string; urgency: 'now' | 'today' | 'this_week' | 'later' }[];
  nextBestAction: { action: string; why: string; urgency: 'now' | 'today' | 'this_week' | 'later'; deadline: string };
  health: 'on_track' | 'needs_attention' | 'at_risk' | 'won' | 'lost';
  winLikelihood: 'high' | 'medium' | 'low' | 'closed';
  winLikelihoodReason: string;
  summary: string;
  lastContact: string;
  waitingOn: 'us' | 'customer' | 'nobody' | 'unknown';
  customerNeeds: string[];
  risks: string[];
  nextAction: string;
  plan: { step: string; owner: 'salesperson' | 'manager' | 'customer'; when: string }[];
  missingInfo: string[];
  suggestedMessage: string;
}

export interface DealEmail {
  id: string;
  direction: 'in' | 'out';
  at: Date;
  subject: string;
  from?: string;
  to?: string;
  preview: string;
  // Incoming only: the AI's one-line reading, and whether a reply is still owed.
  summary?: string;
  waitingForReply?: boolean;
  repliedAt?: Date;
  mailboxOwner?: string;
}

export interface DealCall {
  id: string;
  at: Date;
  kind: 'phone' | 'live' | 'upload';
  personName: string;
  durationSeconds?: number;
  connected: boolean;
  sessionId?: string;
  headline?: string;
  outcome?: string;
  score?: number;
  summaryPoints: string[];
  followUps: string[];
}

export interface DealOverview {
  deal: {
    id: string;
    name: string;
    status: 'open' | 'won' | 'lost';
    value: number;
    currency: string;
    stage?: string;
    expectedClosingDate?: string;
    closedAt?: Date;
    createdAt?: Date;
    lastActivityAt?: Date;
    leadSource?: string;
    product?: string;
    lostReason?: string;
    provider?: string;
    ownerName?: string;
    crmOwner?: string;
    businessName: string;
  };
  customer: { name?: string; company?: string; email?: string; phone?: string; addresses: string[] };
  quotes: { id: string; number?: string; name?: string; amount: number; currency: string; status: string; approval?: string; createdAt?: Date; expires?: string; owner?: string }[];
  notes: { id: string; body: string; at?: Date; by?: string }[];
  emails: DealEmail[];
  calls: DealCall[];
  history: { at: Date; kind: string; entity: string; ref?: string; from?: string; to?: string; value?: number; by?: string; byAi: boolean }[];
  stats: { emailsIn: number; emailsOut: number; waitingForReply: number; calls: number; notes: number; quotes: number; lastContactAt?: Date; daysSinceLastContact?: number };
  health: DealHealth;
  tasks: DealTask[];
  assignments: { at: Date; from?: string; to?: string; by?: string; reason?: string }[];
  actions: DealAgentAction[];
  brief: (DealBrief & { generatedAt: Date; stale: boolean }) | null;
}

export interface DealTask {
  id: string;
  title: string;
  dueDate?: Date;
  status: 'open' | 'done';
  overdue: boolean;
  assignee?: string;
  byAi: boolean;
  createdAt?: Date;
  completedAt?: Date;
}

export const DEAL_ACTION_TYPES = ['create_task', 'add_note', 'notify_owner', 'draft_email'] as const;
export type DealActionType = (typeof DEAL_ACTION_TYPES)[number];

/** One action the AI proposed and a person approved (deal_agent_actions) — the execution history. */
export interface DealAgentAction {
  id: string;
  type: DealActionType;
  status: 'done' | 'failed' | 'duplicate';
  summary: string;
  error?: string;
  by?: string;
  at: Date;
}

export interface DealActionRequest {
  type: DealActionType;
  // The same key twice runs the action once (a double click, a retry).
  idempotencyKey: string;
  title?: string;
  dueDate?: string;
  text?: string;
  subject?: string;
}

const ACTIONS_COLLECTION = 'deal_agent_actions';
const TASKS_COLLECTION = 'customer_tasks';

// Mail services anyone can sign up to: a shared domain says nothing about which company wrote.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.com.au',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'rediffmail.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'zohomail.in',
  'gmx.com',
  'yandex.com',
  'bigpond.com',
  'optusnet.com.au',
]);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const DAY_MS = 86_400_000;

// The deal panel the Dashboard's lists open (Revenue, Pipeline, Won deals…):
// everything recorded about one deal in one place — the deal, its customer,
// quotations, CRM notes, the emails exchanged with the customer, the calls
// with their AI summaries and scores, and the history of changes — read
// straight from the stored records, no AI. The AI brief ("where does this
// lead stand, what next") is written only when someone clicks Analyse
// (decided 2026-11-12), billed like the Customers page's analysis, and kept
// until something new arrives for the deal (then marked out of date).
@Injectable()
export class DealInsightService implements OnModuleInit {
  private readonly logger = new Logger(DealInsightService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectConnection() private connection: Connection,
    private scopes: TeamScopeService,
    private reservations: ReservationService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  // One action per key and business — what makes a repeated click harmless.
  async onModuleInit(): Promise<void> {
    await this.col(ACTIONS_COLLECTION)
      .createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true, name: 'one_action_per_key' })
      .catch((err: Error) => this.logger.warn(`deal_agent_actions index: ${err.message}`));
    await this.col(ASSIGNMENT_HISTORY_COLLECTION)
      .createIndex({ organizationId: 1, dealId: 1, at: -1 }, { name: 'deal_history' })
      .catch((err: Error) => this.logger.warn(`deal_assignment_history index: ${err.message}`));
  }

  private col(name: string) {
    return this.connection.collection(name);
  }

  /**
   * The deal, if the caller may open it: in their business (or, for the Main
   * Account owner, any of their businesses); the whole business's deals for
   * an owner or admin, a manager's store's, otherwise only their own.
   */
  private async loadDeal(caller: JwtPayload, dealId: string): Promise<{ deal: Doc; business: { id: string; name: string; timeZone: string } }> {
    if (!isValidObjectId(dealId)) throw new NotFoundException('Deal not found.');
    const scope = await this.scopes.resolve(caller);
    const deal = await this.col('crm_deals').findOne({ _id: new Types.ObjectId(dealId), organizationId: { $in: scope.businesses.map((b) => b.id) } });
    if (!deal) throw new NotFoundException('Deal not found.');
    const mine = deal.ownerId === caller.sub;
    const allowed = mine || (scope.team && (!scope.storeId || deal.storeId === scope.storeId));
    if (!allowed) throw new ForbiddenException('This deal belongs to someone else.');
    const business = scope.businesses.find((b) => b.id === deal.organizationId)!;
    return { deal, business };
  }

  async overview(caller: JwtPayload, dealId: string): Promise<DealOverview> {
    const { deal, business } = await this.loadDeal(caller, dealId);
    const facts = await this.gather(deal, business);
    const saved = await this.col('deal_briefs').findOne({ organizationId: deal.organizationId, dealId });
    const brief = saved ? { ...(saved.result as DealBrief), generatedAt: saved.generatedAt as Date, stale: saved.factsHash !== facts.hash } : null;
    return { ...facts.overview, brief };
  }

  async analyse(caller: JwtPayload, dealId: string): Promise<DealOverview['brief']> {
    if (caller.aiAccessEnabled === false) throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    const { deal, business } = await this.loadDeal(caller, dealId);
    const facts = await this.gather(deal, business);

    // Billed like every other button-triggered AI action: reserve first (a
    // hard stop when there are no credits), settle on success, release on failure.
    const requestId = randomUUID();
    await this.reservations.reserve(this.reservations.resolveTenantKey(caller.organizationId, caller.sub), caller.sub, requestId, 'deal-brief');
    let result: DealBrief;
    try {
      const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
      const { data } = await firstValueFrom(
        this.http.post<DealBrief>(`${this.pythonAgentUrl}/deals/brief`, { ...facts.forAi, request_id: requestId }, { headers: { Authorization: `Bearer ${token}` }, timeout: 90_000 }),
      );
      await this.reservations.settle(requestId);
      result = data;
    } catch (err) {
      await this.reservations.release(requestId);
      this.logger.error(`Deal brief failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The AI couldn’t analyse this deal right now. Please try again in a minute.');
    }
    const generatedAt = new Date();
    await this.col('deal_briefs').updateOne(
      { organizationId: deal.organizationId, dealId },
      { $set: { organizationId: deal.organizationId, dealId, result, factsHash: facts.hash, generatedAt, generatedBy: caller.sub } },
      { upsert: true },
    );
    return { ...result, generatedAt, stale: false };
  }

  // ---- approved actions ------------------------------------------------------------

  /**
   * Runs one action a person approved in the deal panel (the AI proposes, a
   * person decides). Nothing here leaves HaiVE on its own: a task and a note
   * are HaiVE records (the external CRM is never written to), the owner is told
   * inside HaiVE, and an email is only drafted — a person sends it. Every run is
   * recorded (deal_agent_actions + the audit log), once per idempotency key.
   */
  async runAction(caller: JwtPayload, dealId: string, request: DealActionRequest): Promise<DealAgentAction> {
    const { deal } = await this.loadDeal(caller, dealId);
    const organizationId: string = deal.organizationId;
    const actions = this.col(ACTIONS_COLLECTION);
    const previous = await actions.findOne({ organizationId, idempotencyKey: request.idempotencyKey });
    if (previous) return this.toAction(previous, caller);

    let summary = '';
    let status: DealAgentAction['status'] = 'done';
    let error: string | undefined;
    const result: Record<string, unknown> = {};
    try {
      if (request.type === 'create_task') {
        const title = request.title?.trim();
        if (!title) throw new BadRequestException('Give the task a title.');
        // The same open task twice is one task: no duplicate follow-ups.
        const same = await this.col(TASKS_COLLECTION).findOne({ organizationId, dealId, status: 'open', title });
        if (same) {
          status = 'duplicate';
          summary = `Task already open: ${title}`;
          result.taskId = same._id.toString();
        } else {
          const due = request.dueDate && !Number.isNaN(Date.parse(request.dueDate)) ? new Date(request.dueDate) : undefined;
          const assigneeId: string = deal.ownerId ?? caller.sub;
          const assignee = isValidObjectId(assigneeId) ? await this.col('users').findOne({ _id: new Types.ObjectId(assigneeId) }, { projection: { name: 1 } }) : null;
          const inserted = await this.col(TASKS_COLLECTION).insertOne({
            organizationId,
            dealId,
            customerKeys: [],
            title,
            ...(due ? { dueDate: due } : {}),
            assigneeId,
            assigneeName: assignee?.name,
            status: 'open',
            source: 'deal-ai',
            createdBy: caller.sub,
            createdAt: new Date(),
          });
          summary = `Task created: ${title}${assignee?.name ? ` (for ${assignee.name})` : ''}`;
          result.taskId = inserted.insertedId.toString();
        }
      } else if (request.type === 'add_note') {
        const body = request.text?.trim();
        if (!body) throw new BadRequestException('Write the note first.');
        const inserted = await this.col('crm_notes').insertOne({
          organizationId,
          dealId,
          ...(deal.contactId ? { contactId: String(deal.contactId) } : {}),
          body,
          createdBy: caller.sub,
          source: 'deal-ai',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        summary = 'Note added to the deal (in HaiVE)';
        result.noteId = inserted.insertedId.toString();
      } else if (request.type === 'notify_owner') {
        if (!deal.ownerId) throw new BadRequestException('This deal has no owner in HaiVE to notify. Assign it first.');
        const message = request.text?.trim() || `Please look at ${deal.name}.`;
        await this.notifications.create(String(deal.ownerId), { title: `Deal needs attention: ${deal.name}`, description: message.slice(0, 500), kind: 'warning', source: 'deal-insight' }, organizationId);
        const owner = isValidObjectId(String(deal.ownerId)) ? await this.col('users').findOne({ _id: new Types.ObjectId(String(deal.ownerId)) }, { projection: { name: 1 } }) : null;
        summary = `${owner?.name ?? 'The owner'} notified`;
      } else if (request.type === 'draft_email') {
        const body = request.text?.trim();
        if (!body) throw new BadRequestException('There is no message to draft.');
        summary = `Email drafted${request.subject ? `: ${request.subject.trim()}` : ''} — to be sent by a person`;
        result.subject = request.subject?.trim();
        result.text = body.slice(0, 5000);
      } else {
        throw new BadRequestException('Unknown action.');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      status = 'failed';
      error = 'The action couldn’t be completed. Please try again.';
      summary = `${request.type.replace(/_/g, ' ')} failed`;
      this.logger.error(`Deal action ${request.type} failed: ${(err as Error).message}`);
    }

    const doc = { organizationId, dealId, type: request.type, idempotencyKey: request.idempotencyKey, status, summary, ...(error ? { error } : {}), result, requestedBy: caller.sub, at: new Date() };
    try {
      await actions.insertOne(doc);
    } catch (err) {
      // The same key at the same moment (two tabs): the first one stands.
      const first = await actions.findOne({ organizationId, idempotencyKey: request.idempotencyKey });
      if (first) return this.toAction(first, caller);
      throw err;
    }
    void this.audit.log({
      userId: caller.loginUserId ?? caller.sub,
      organizationId,
      method: 'POST',
      route: '/deal-insight/actions',
      statusCode: status === 'failed' ? 500 : 200,
      durationMs: 0,
      action: `deal-action:${request.type}`,
      metadata: { dealId, status, summary },
    });
    return this.toAction(doc, caller);
  }

  /** Marks one of the deal's tasks done (or open again). */
  async setTaskDone(caller: JwtPayload, dealId: string, taskId: string, done: boolean): Promise<DealTask> {
    const { deal } = await this.loadDeal(caller, dealId);
    if (!isValidObjectId(taskId)) throw new NotFoundException('Task not found.');
    const filter = { _id: new Types.ObjectId(taskId), organizationId: deal.organizationId, dealId };
    const update = done ? { $set: { status: 'done', completedAt: new Date(), completedBy: caller.sub } } : { $set: { status: 'open' }, $unset: { completedAt: '', completedBy: '' } };
    const task = await this.col(TASKS_COLLECTION).findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (!task) throw new NotFoundException('Task not found.');
    const due = task.dueDate instanceof Date ? task.dueDate : undefined;
    return {
      id: task._id.toString(),
      title: task.title,
      dueDate: due,
      status: task.status === 'done' ? 'done' : 'open',
      overdue: task.status !== 'done' && !!due && due.getTime() < Date.now(),
      assignee: task.assigneeName,
      byAi: task.source === 'deal-ai',
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    };
  }

  private toAction(doc: Doc, caller: JwtPayload): DealAgentAction {
    return {
      id: String(doc._id ?? ''),
      type: doc.type,
      status: doc.status,
      summary: doc.summary,
      error: doc.error,
      by: doc.requestedBy === caller.sub ? 'You' : undefined,
      at: doc.at,
    };
  }

  // ---- the facts --------------------------------------------------------------------

  private async names(ids: (string | undefined)[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids.filter((id): id is string => !!id && isValidObjectId(id)))];
    if (valid.length === 0) return new Map();
    const users = await this.col('users')
      .find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) } }, { projection: { name: 1, email: 1 } })
      .toArray();
    return new Map(users.map((u) => [u._id.toString(), (u.name as string) || (u.email as string) || 'Someone']));
  }

  private async gather(deal: Doc, business: { id: string; name: string; timeZone: string }) {
    const organizationId: string = deal.organizationId;
    const dealId = deal._id.toString();
    const now = new Date();

    const [contact, account, org, quotes, mapping] = await Promise.all([
      deal.contactId && isValidObjectId(deal.contactId) ? this.col('crm_contacts').findOne({ _id: new Types.ObjectId(deal.contactId), organizationId }) : null,
      deal.accountId && isValidObjectId(deal.accountId) ? this.col('crm_accounts').findOne({ _id: new Types.ObjectId(deal.accountId), organizationId }) : null,
      this.col('organizations').findOne({ _id: new Types.ObjectId(organizationId) }, { projection: { currency: 1 } }),
      this.col('crm_quotes')
        .find({ organizationId, dealId: { $in: [dealId, ...(deal.externalId ? [String(deal.externalId)] : [])] } })
        .sort({ createdAt: -1 })
        .limit(15)
        .toArray(),
      deal.externalOwnerRef ? this.col('crm_deal_owner_mappings').findOne({ organizationId, externalOwnerRef: deal.externalOwnerRef }) : null,
    ]);
    const currency: string = text(quotes[0]?.currency) ?? text(org?.currency) ?? 'INR';

    // Who the customer is, and every address and number they are reached on.
    const addresses = new Set<string>();
    const phones = new Set<string>();
    const addAddress = (value: unknown) => {
      const email = text(value)?.toLowerCase();
      if (email && email.includes('@')) addresses.add(email);
    };
    const addPhone = (value: unknown) => {
      const digits = String(value ?? '').replace(/\D/g, '');
      if (digits.length >= 8) phones.add(digits.slice(-10));
    };
    addAddress(contact?.email);
    addPhone(contact?.phone);
    for (const q of quotes) {
      addAddress(q.clientDetails?.email);
      addPhone(q.clientDetails?.phone);
    }
    const domains = new Set<string>();
    for (const email of addresses) {
      const domain = email.split('@')[1];
      if (domain && !FREE_MAIL_DOMAINS.has(domain)) domains.add(domain);
    }
    const accountDomain = text(account?.domain)?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (accountDomain && !FREE_MAIL_DOMAINS.has(accountDomain)) domains.add(accountDomain);

    const addressPatterns = [...addresses].map((a) => new RegExp(`^${escapeRegex(a)}$`, 'i'));
    const domainPatterns = [...domains].map((d) => new RegExp(`@${escapeRegex(d)}$`, 'i'));
    const mailPatterns = [...addressPatterns, ...domainPatterns];

    const phonePatterns = [...phones].map((p) => new RegExp(`${escapeRegex(p)}$`));
    const [inbound, outbound, notes, sessions, phoneCalls, history] = await Promise.all([
      mailPatterns.length
        ? this.col('email_intelligence_items')
            .find(
              { organizationId, fromAddress: { $in: mailPatterns } },
              {
                projection: {
                  userId: 1,
                  receivedAt: 1,
                  subject: 1,
                  fromAddress: 1,
                  fromName: 1,
                  bodyPreview: 1,
                  reason: 1,
                  status: 1,
                  shouldDraft: 1,
                  expectedNextAction: 1,
                  aiStatus: 1,
                  sentAt: 1,
                  externalReplyDetectedAt: 1,
                  threadRespondedAt: 1,
                  threadHead: 1,
                  mailboxRemovedAt: 1,
                },
              },
            )
            .sort({ receivedAt: -1 })
            .limit(20)
            .toArray()
        : [],
      mailPatterns.length
        ? this.col('email_sent_items')
            .find({ organizationId, toAddresses: { $in: mailPatterns } }, { projection: { userId: 1, sentAt: 1, subject: 1, toAddresses: 1, bodyPreview: 1 } })
            .sort({ sentAt: -1 })
            .limit(20)
            .toArray()
        : [],
      this.col('crm_notes')
        .find({ organizationId, $or: [{ dealId }, ...(deal.contactId ? [{ contactId: String(deal.contactId), dealId: { $exists: false } }] : [])] })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      this.col('call_sessions')
        .find(
          { organizationId, dealId },
          { projection: { userId: 1, source: 1, status: 1, createdAt: 1, endedAt: 1, headline: 1, outcome: 1, overallScore: 1, summaryPoints: 1, followUpActions: 1 } },
        )
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      Promise.all(
        ['plivo_calls', 'twilio_calls'].map((name) =>
          this.col(name)
            .find({ organizationId, $or: [{ dealId }, ...(phonePatterns.length ? [{ customerNumber: { $in: phonePatterns } }] : [])] })
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray(),
        ),
      ).then((lists) => lists.flat()),
      this.col('crm_activities')
        .find({ organizationId, $or: [{ entity: 'deal', entityId: dealId }, { dealId }] })
        .sort({ occurredAt: 1 })
        .limit(60)
        .toArray(),
    ]);
    const [taskDocs, assignmentDocs, actionDocs] = await Promise.all([
      this.col(TASKS_COLLECTION).find({ organizationId, dealId }).sort({ status: -1, dueDate: 1 }).limit(30).toArray(),
      this.col(ASSIGNMENT_HISTORY_COLLECTION).find({ organizationId, dealId }).sort({ at: -1 }).limit(20).toArray(),
      this.col(ACTIONS_COLLECTION).find({ organizationId, dealId }).sort({ at: -1 }).limit(20).toArray(),
    ]);

    // A phone call's recording (its summary and score) may not carry the deal: fetch it by the call.
    const knownSessions = new Set(sessions.map((s) => s._id.toString()));
    const recordingIds = phoneCalls.map((c) => c.sessionId).filter((id): id is string => typeof id === 'string' && isValidObjectId(id) && !knownSessions.has(id));
    const recordings = recordingIds.length
      ? await this.col('call_sessions')
          .find(
            { _id: { $in: recordingIds.map((id) => new Types.ObjectId(id)) }, organizationId },
            { projection: { userId: 1, source: 1, status: 1, createdAt: 1, headline: 1, outcome: 1, overallScore: 1, summaryPoints: 1, followUpActions: 1 } },
          )
          .toArray()
      : [];
    const sessionById = new Map([...sessions, ...recordings].map((s) => [s._id.toString(), s]));

    const nameOf = await this.names([
      deal.ownerId,
      ...inbound.map((e) => e.userId),
      ...outbound.map((e) => e.userId),
      ...notes.map((n) => n.createdBy),
      ...sessions.map((s) => s.userId),
      ...phoneCalls.map((c) => c.userId),
      ...history.map((h) => h.actorUserId),
      ...taskDocs.map((t) => t.assigneeId),
      ...assignmentDocs.flatMap((a) => [a.fromOwnerId, a.toOwnerId, a.assignedBy]),
      ...actionDocs.map((a) => a.requestedBy),
    ]);

    // ---- assembled for the panel ----
    const emails: DealEmail[] = [
      ...inbound.map((e) => {
        const responded = deriveRespondedInfo(e);
        return {
          id: e._id.toString(),
          direction: 'in' as const,
          at: e.receivedAt as Date,
          subject: (e.subject as string) || '(no subject)',
          from: (e.fromName as string) || (e.fromAddress as string),
          preview: (e.bodyPreview as string) ?? '',
          summary: text(e.reason),
          waitingForReply: deriveResponseStatus(e) === 'needs_response',
          repliedAt: responded.respondedAt,
          mailboxOwner: nameOf.get(String(e.userId)),
        };
      }),
      ...outbound.map((e) => ({
        id: e._id.toString(),
        direction: 'out' as const,
        at: e.sentAt as Date,
        subject: (e.subject as string) || '(no subject)',
        to: ((e.toAddresses as string[] | undefined) ?? []).join(', '),
        preview: (e.bodyPreview as string) ?? '',
        mailboxOwner: nameOf.get(String(e.userId)),
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const scoreOf = (s?: Doc) => (s && typeof s.overallScore === 'number' && s.overallScore > 0 ? s.overallScore : undefined);
    const sessionFacts = (s?: Doc) => ({
      headline: text(s?.headline),
      outcome: text(s?.outcome),
      score: scoreOf(s),
      summaryPoints: ((s?.summaryPoints as string[] | undefined) ?? []).slice(0, 5),
      followUps: ((s?.followUpActions as { text: string }[] | undefined) ?? []).map((f) => f.text).slice(0, 5),
    });
    const linkedSessionIds = new Set(phoneCalls.map((c) => String(c.sessionId ?? '')));
    const calls: DealCall[] = [
      ...phoneCalls.map((c) => {
        const session = c.sessionId ? sessionById.get(String(c.sessionId)) : undefined;
        return {
          id: c._id.toString(),
          at: c.createdAt as Date,
          kind: 'phone' as const,
          personName: nameOf.get(String(c.userId)) ?? 'Former user',
          durationSeconds: c.durationSeconds,
          connected: !!c.answeredAt,
          sessionId: session?._id.toString(),
          ...sessionFacts(session),
        };
      }),
      ...sessions
        .filter((s) => !linkedSessionIds.has(s._id.toString()))
        .map((s) => ({
          id: s._id.toString(),
          at: s.createdAt as Date,
          kind: (s.source === 'live' ? 'live' : 'upload') as DealCall['kind'],
          personName: nameOf.get(String(s.userId)) ?? 'Former user',
          durationSeconds: s.source === 'live' && s.endedAt instanceof Date ? Math.round((s.endedAt.getTime() - (s.createdAt as Date).getTime()) / 1000) : undefined,
          connected: s.status !== 'error',
          sessionId: s._id.toString(),
          ...sessionFacts(s),
        })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const lastContactAt = [emails[0]?.at, calls.find((c) => c.connected)?.at]
      .filter((d): d is Date => !!d)
      .map((d) => new Date(d))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const today = businessDayOf(business.timeZone, now);
    const tasks: DealTask[] = taskDocs.map((t) => {
      const due = t.dueDate instanceof Date ? t.dueDate : undefined;
      const done = t.status === 'done';
      return {
        id: t._id.toString(),
        title: (t.title as string) ?? 'Task',
        dueDate: due,
        status: done ? 'done' : 'open',
        overdue: !done && !!due && due.getTime() < now.getTime(),
        assignee: t.assigneeId ? nameOf.get(String(t.assigneeId)) : undefined,
        byAi: t.source === 'deal-ai',
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      };
    });
    const thirtyDaysAgo = now.getTime() - 30 * DAY_MS;
    const health = dealHealth({
      status: deal.dealStatus ?? 'open',
      daysSinceLastContact: lastContactAt ? Math.floor((now.getTime() - lastContactAt.getTime()) / DAY_MS) : undefined,
      waitingForReply: emails.filter((e) => e.waitingForReply).length,
      customerMessagesLast30Days: emails.filter((e) => e.direction === 'in' && new Date(e.at).getTime() >= thirtyDaysAgo).length,
      connectedCallsLast30Days: calls.filter((c) => c.connected && new Date(c.at).getTime() >= thirtyDaysAgo).length,
      quoteStatuses: quotes.map((q) => ({ status: String(q.quoteStatus ?? 'draft'), approval: text(q.clientApprovalStatus) })),
      callScores: calls.map((c) => c.score).filter((v): v is number => typeof v === 'number'),
      expectedClosingDate: text(deal.expectedClosingDate),
      today,
      overdueFollowUps: tasks.filter((t) => t.overdue).length,
    });

    const stage = text(deal.stageId);
    const overview: Omit<DealOverview, 'brief'> = {
      deal: {
        id: dealId,
        name: deal.name ?? 'Deal',
        status: deal.dealStatus ?? 'open',
        value: deal.monetaryValue ?? 0,
        currency,
        stage: stage && !isValidObjectId(stage) ? stage : undefined,
        expectedClosingDate: text(deal.expectedClosingDate)?.slice(0, 10),
        closedAt: deal.closedAt,
        createdAt: deal.createdAt,
        lastActivityAt: deal.lastActivityAt,
        leadSource: text(deal.leadSource),
        product: text(deal.product),
        lostReason: text(deal.lostReason),
        provider: text(deal.sourceProvider),
        ownerName: deal.ownerId ? nameOf.get(String(deal.ownerId)) : undefined,
        crmOwner: text(deal.externalOwnerLabel) ?? text(mapping?.externalOwnerLabel) ?? text(deal.externalOwnerRef),
        businessName: business.name,
      },
      customer: {
        name: text(contact?.name) ?? ([contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || undefined) ?? text(quotes[0]?.clientDetails?.contactName),
        company: text(account?.name) ?? text(quotes[0]?.clientDetails?.companyName),
        email: text(contact?.email) ?? text(quotes[0]?.clientDetails?.email),
        phone: text(contact?.phone) ?? text(quotes[0]?.clientDetails?.phone),
        addresses: [...addresses],
      },
      quotes: quotes.map((q) => ({
        id: q._id.toString(),
        number: text(q.quoteNumber),
        name: text(q.quoteName),
        amount: q.quoteAmount ?? 0,
        currency: text(q.currency) ?? currency,
        status: q.quoteStatus ?? 'draft',
        approval: text(q.clientApprovalStatus),
        createdAt: q.createdAt,
        expires: text(q.expirationDate),
        owner: text(q.quoteOwnerLabel) ?? (q.ownerUserId ? nameOf.get(String(q.ownerUserId)) : undefined),
      })),
      notes: notes.map((n) => ({ id: n._id.toString(), body: (n.body as string) ?? '', at: n.createdAt, by: n.createdBy ? nameOf.get(String(n.createdBy)) : undefined })),
      emails,
      calls,
      history: history.map((h) => ({
        at: h.occurredAt,
        kind: h.kind,
        entity: h.entity,
        ref: text(h.ref),
        from: text(h.fromStatus),
        to: text(h.toStatus),
        value: typeof h.value === 'number' ? h.value : undefined,
        by: h.actorUserId ? nameOf.get(String(h.actorUserId)) : text(h.crmOwnerLabel),
        byAi: !!h.byAi,
      })),
      stats: {
        emailsIn: inbound.length,
        emailsOut: outbound.length,
        waitingForReply: emails.filter((e) => e.waitingForReply).length,
        calls: calls.length,
        notes: notes.length,
        quotes: quotes.length,
        lastContactAt,
        daysSinceLastContact: lastContactAt ? Math.floor((now.getTime() - lastContactAt.getTime()) / DAY_MS) : undefined,
      },
      health,
      tasks,
      assignments: assignmentDocs.map((a) => ({
        at: a.at,
        from: a.fromOwnerId ? (nameOf.get(String(a.fromOwnerId)) ?? 'Former user') : undefined,
        to: a.toOwnerId ? (nameOf.get(String(a.toOwnerId)) ?? 'Former user') : undefined,
        by: a.assignedBy ? nameOf.get(String(a.assignedBy)) : undefined,
        reason: text(a.reason),
      })),
      actions: actionDocs.map((a) => ({
        id: a._id.toString(),
        type: a.type,
        status: a.status,
        summary: a.summary,
        error: text(a.error),
        by: a.requestedBy ? nameOf.get(String(a.requestedBy)) : undefined,
        at: a.at,
      })),
    };

    // What the AI reads: the same facts, compact, oldest first within each kind, with today's date.
    const forAi = {
      today: businessDayOf(business.timeZone, now),
      business: { name: business.name, currency },
      deal: overview.deal,
      customer: { ...overview.customer, addresses: undefined },
      quotes: overview.quotes,
      crmNotes: overview.notes.map((n) => ({ at: n.at, by: n.by, note: n.body.slice(0, 1500) })),
      emails: overview.emails
        .slice(0, 15)
        .reverse()
        .map((e) => ({
          at: e.at,
          direction: e.direction === 'in' ? 'from customer' : 'to customer',
          subject: e.subject,
          preview: e.preview.slice(0, 600),
          aiReading: e.summary,
          stillWaitingForOurReply: e.direction === 'in' ? e.waitingForReply : undefined,
          handledBy: e.mailboxOwner,
        })),
      calls: overview.calls
        .slice(0, 8)
        .reverse()
        .map((c) => ({ at: c.at, by: c.personName, connected: c.connected, minutes: c.durationSeconds ? Math.round(c.durationSeconds / 60) : undefined, headline: c.headline, outcome: c.outcome, coachScoreOutOf10: c.score, summary: c.summaryPoints, followUps: c.followUps })),
      history: overview.history.slice(-30),
      lastContactDaysAgo: overview.stats.daysSinceLastContact,
      // Worked out from the records by HaiVE (not by the AI): context only, never to be restated as the AI's own score.
      healthScore: { score: health.score, factors: health.factors.map((f) => `${f.label}: ${f.detail}`) },
      openTasks: tasks.filter((t) => t.status === 'open').map((t) => ({ title: t.title, due: t.dueDate, overdue: t.overdue, assignee: t.assignee })),
      ownerChanges: overview.assignments.slice(0, 5),
    };

    // The brief is out of date once anything it read has changed.
    const hash = createHash('sha1')
      .update(
        JSON.stringify([
          deal.dealStatus,
          deal.monetaryValue,
          deal.expectedClosingDate,
          deal.stageId,
          quotes.map((q) => [q._id.toString(), q.quoteStatus, q.clientApprovalStatus, q.quoteAmount]),
          notes.map((n) => n._id.toString()),
          emails.map((e) => [e.id, e.waitingForReply]),
          calls.map((c) => [c.id, c.score, c.headline]),
          history.length,
          tasks.map((t) => [t.id, t.status]),
          assignmentDocs.length,
        ]),
      )
      .digest('hex');

    return { overview, forAi, hash };
  }
}
