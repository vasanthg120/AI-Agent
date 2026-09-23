import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Achievement } from '../gamification/achievements';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
import { Account, AccountDocument } from '../crm/schemas/account.schema';
import { Contact, ContactDocument } from '../crm/schemas/contact.schema';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument } from '../email-intelligence/schemas/email-intelligence-item.schema';
// Plain value import, not the module/service — RELEVANT_EMAIL_INTENTS is
// just an exported constant array, so this carries no NestJS DI/module
// dependency. Importing EmailIntelligenceModule itself here isn't an
// option: it imports CrmModule, which imports DashboardModule (see
// dashboard.module.ts's own comment) — a real cycle. Registering the
// EmailIntelligenceItem schema directly (below) is the established
// workaround this file's sibling dashboard.service.ts already uses.
import { RELEVANT_EMAIL_INTENTS } from '../email-intelligence/email-intelligence.service';
import { resolveAllowedAgentIds } from './agent-scope.util';
import { isTaskVisibleToUser } from './task-visibility.util';
import { DailyReport, DailyReportDocument } from './schemas/daily-report.schema';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';

export interface TaskOut {
  id: string;
  title: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  category?: string;
  isOverdue: boolean;
  status: 'todo' | 'in_progress' | 'done';
  agentId: string;
  reportId: string;
  reportType: 'morning' | 'eod';
  date: string;
  // Additive — set only when dashboard.service.ts's recordDailyReport could
  // resolve a real owner (see its attributeTask); undefined means the task
  // stays shared/unassigned exactly as every task was before this existed.
  assignedUserId?: string;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Half-open [start, end) UTC range for a given "YYYY-MM-DD" date — matches
// todayStamp()'s own UTC convention (and DailyReport.date's UTC-bucketed
// "YYYY-MM-DD"), so a createdAt/updatedAt/receivedAt timestamp check here
// never disagrees with which calendar day a DailyReport itself considers
// that date to be. Works for any date, not just today — getEodSummary
// reuses this for the EOD calendar view's historical dates too.
function dayRange(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export interface EodSummary {
  date: string;
  tasksCompleted: TaskOut[];
  tasksPending: TaskOut[];
  email: { received: number; sent: number; responded: number; pending: number };
  crm: { dealsCreated: number; dealsUpdated: number; quotesCreated: number; quotesUpdated: number };
  // Store-wide, never per-user — Contact/Account have no owner field to
  // scope by (confirmed: neither schema carries an ownerId/ownerUserId),
  // so attributing these to "you" specifically would be fabricated, not
  // real. Labeled as such in the API shape rather than silently implying
  // personal attribution the data can't support.
  newContactsAcrossOrg: number;
  newAccountsAcrossOrg: number;
  narrativeSummary: string | null;
  reportExists: boolean;
  reportGeneratedAt: Date | null;
}

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(DailyReport.name) private reportModel: Model<DailyReportDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    @InjectModel(Account.name) private accountModel: Model<AccountDocument>,
    @InjectModel(EmailIntelligenceItem.name) private emailModel: Model<EmailIntelligenceItemDocument>,
    private chatService: ChatService,
    private gamificationService: GamificationService,
    private timelineService: TimelineService,
  ) {}

  async list(query: ListTasksQueryDto, caller: JwtPayload): Promise<{ tasks: TaskOut[] }> {
    const allowedAgentIds = await resolveAllowedAgentIds(this.chatService, caller);
    const from = query.dateFrom ?? todayStamp();
    const to = query.dateTo ?? query.dateFrom ?? todayStamp();

    const reports = await this.reportModel
      .find({ organizationId: caller.organizationId, agentId: { $in: allowedAgentIds }, date: { $gte: from, $lte: to } })
      .lean()
      .exec();

    // Default (mine omitted) is now the personal view — assigned-to-me or
    // still-unassigned tasks only, enforced here server-side regardless of
    // what the frontend sends, so a caller can never see another user's
    // explicitly-assigned tasks just by leaving a query param off. An
    // explicit mine=false is the only way to see the full shared board (the
    // pre-existing behavior, still available — e.g. an owner/manager
    // reviewing the whole store — never gated behind caller-supplied
    // identity, only behind this one boolean).
    const mineFilter = query.mine ?? true;

    const tasks = reports.flatMap((r) =>
      r.tasks
        .filter((t) => !query.status || t.status === query.status)
        .filter((t) => !mineFilter || isTaskVisibleToUser(t, caller.sub))
        .map((t) => ({
          id: t._id.toString(),
          title: t.title,
          priority: t.priority,
          category: t.category,
          isOverdue: t.isOverdue,
          status: t.status,
          agentId: r.agentId,
          reportId: r._id.toString(),
          reportType: r.reportType,
          date: r.date,
          assignedUserId: t.assignedUserId,
        })),
    );
    return { tasks };
  }

  // mine defaults to true (same reasoning as list() above) — the calendar
  // heatmap's counts now reflect the viewer's own board by default, matching
  // whatever they'd actually see if they clicked into that day. reportType
  // is additive/optional — omitted (the TODO board's own calendar) keeps
  // counting both morning+eod reports exactly as before; the EOD page's own
  // calendar passes 'eod' so a day with only a morning report (no EOD one
  // generated yet) doesn't misleadingly show as having EOD data.
  async calendarSummary(month: string, caller: JwtPayload, mine = true, reportType?: 'morning' | 'eod') {
    const allowedAgentIds = await resolveAllowedAgentIds(this.chatService, caller);
    const reports = await this.reportModel
      .find({
        organizationId: caller.organizationId,
        agentId: { $in: allowedAgentIds },
        date: { $regex: `^${month}` },
        ...(reportType ? { reportType } : {}),
      })
      .lean()
      .exec();

    const byDate = new Map<string, { reportCount: number; taskCount: number; hasUrgent: boolean }>();
    for (const r of reports) {
      const visibleTasks = mine ? r.tasks.filter((t) => isTaskVisibleToUser(t, caller.sub)) : r.tasks;
      const cur = byDate.get(r.date) ?? { reportCount: 0, taskCount: 0, hasUrgent: false };
      cur.reportCount += 1;
      cur.taskCount += visibleTasks.length;
      cur.hasUrgent = cur.hasUrgent || visibleTasks.some((t) => t.priority === 'urgent');
      byDate.set(r.date, cur);
    }
    return { month, days: [...byDate.entries()].map(([date, v]) => ({ date, ...v })) };
  }

  /** The real, non-LLM "what happened [that day]" data behind the EOD page —
   * every figure here is a live aggregate against the actual data it
   * describes (never an LLM-narrated approximation), matching this
   * codebase's own established "never fabricate a number" convention (see
   * gross-margin-report.service.ts / vendor-profitability.service.ts). The
   * one AI-generated piece (narrativeSummary) is read from the SAME
   * DailyReport a scheduled crew run already produced — reused, not
   * regenerated, so calling this endpoint never triggers a new LLM call.
   * `date` defaults to today (the original behavior) — the EOD page's
   * Calendar view passes an explicit past date to look up a historical
   * day's EOD report the exact same way. An invalid/malformed date string
   * falls back to today rather than building a garbage Mongo range from it. */
  async getEodSummary(caller: JwtPayload, requestedDate?: string): Promise<EodSummary> {
    const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : todayStamp();
    const { start, end } = dayRange(date);
    const { organizationId, sub: userId } = caller;

    const [{ tasks }, emailReceived, emailSent, emailResponded, emailPending, dealsCreated, dealsUpdated, quotesCreated, quotesUpdated, newContacts, newAccounts, eodReport] =
      await Promise.all([
        this.list({ dateFrom: date, dateTo: date }, caller),
        this.emailModel.countDocuments({ organizationId, userId, intent: { $in: RELEVANT_EMAIL_INTENTS }, receivedAt: { $gte: start, $lt: end } }).exec(),
        this.emailModel.countDocuments({ organizationId, userId, intent: { $in: RELEVANT_EMAIL_INTENTS }, sentAt: { $gte: start, $lt: end } }).exec(),
        // "Responded" mirrors EmailIntelligenceService.getEmailProductivityStats'
        // own completed-match: handled either through this app (sentAt) or
        // directly in the mailbox owner's real Outlook client
        // (externalReplyDetectedAt) — a genuine either/or, never double-counted.
        this.emailModel
          .countDocuments({
            organizationId,
            userId,
            intent: { $in: RELEVANT_EMAIL_INTENTS },
            $or: [{ sentAt: { $gte: start, $lt: end } }, { externalReplyDetectedAt: { $gte: start, $lt: end } }],
          })
          .exec(),
        this.emailModel
          .countDocuments({ organizationId, userId, intent: { $in: RELEVANT_EMAIL_INTENTS }, status: 'pending', externalReplyDetectedAt: { $exists: false } })
          .exec(),
        this.dealModel.countDocuments({ organizationId, ownerId: userId, createdAt: { $gte: start, $lt: end } }).exec(),
        this.dealModel.countDocuments({ organizationId, ownerId: userId, updatedAt: { $gte: start, $lt: end } }).exec(),
        this.quoteModel.countDocuments({ organizationId, ownerUserId: userId, createdAt: { $gte: start, $lt: end } }).exec(),
        this.quoteModel.countDocuments({ organizationId, ownerUserId: userId, updatedAt: { $gte: start, $lt: end } }).exec(),
        this.contactModel.countDocuments({ organizationId, createdAt: { $gte: start, $lt: end } }).exec(),
        this.accountModel.countDocuments({ organizationId, createdAt: { $gte: start, $lt: end } }).exec(),
        this.reportModel.findOne({ organizationId, reportType: 'eod', date }).sort({ updatedAt: -1 }).lean().exec(),
      ]);

    return {
      date,
      tasksCompleted: tasks.filter((t) => t.status === 'done'),
      tasksPending: tasks.filter((t) => t.status !== 'done'),
      email: { received: emailReceived, sent: emailSent, responded: emailResponded, pending: emailPending },
      crm: { dealsCreated, dealsUpdated, quotesCreated, quotesUpdated },
      newContactsAcrossOrg: newContacts,
      newAccountsAcrossOrg: newAccounts,
      narrativeSummary: eodReport?.summary || null,
      reportExists: !!eodReport,
      reportGeneratedAt: eodReport?.updatedAt ?? null,
    };
  }

  /** Ownership is enforced inside the same write (agentId: {$in: allowedAgentIds}
   * alongside the task id filter) — not a separate fetch-then-check, so there's
   * no window where a caller could act on a task outside their scope. Returns
   * the same 404 whether the task doesn't exist or belongs to another agent,
   * so an agent_user can't distinguish "missing" from "not yours" by probing ids. */
  async updateStatus(taskId: string, status: 'todo' | 'in_progress' | 'done', caller: JwtPayload) {
    if (!Types.ObjectId.isValid(taskId)) {
      throw new NotFoundException('Task not found');
    }
    const allowedAgentIds = await resolveAllowedAgentIds(this.chatService, caller);
    const taskObjectId = new Types.ObjectId(taskId);
    const filter = {
      'tasks._id': taskObjectId,
      organizationId: caller.organizationId,
      agentId: { $in: allowedAgentIds },
    };

    // Fetched before the update so gamification can tell a genuine
    // todo/in_progress -> done transition from a redundant "mark done again"
    // — awarding points/streak/achievements twice for one real completion
    // would make the whole scoring system untrustworthy.
    const report = await this.reportModel.findOne(filter).exec();
    if (!report) {
      throw new NotFoundException('Task not found');
    }
    const task = report.tasks.find((t) => t._id.equals(taskObjectId));
    const wasAlreadyDone = task?.status === 'done';
    const wasOverdue = task?.isOverdue ?? false;

    await this.reportModel.updateOne(filter, { $set: { 'tasks.$.status': status } }).exec();

    let newAchievements: Achievement[] = [];
    if (status === 'done' && !wasAlreadyDone) {
      const result = await this.gamificationService.recordTaskCompletion(caller.sub, caller.organizationId, wasOverdue);
      newAchievements = result.newAchievements;

      await this.timelineService
        .record({
          organizationId: caller.organizationId,
          userId: caller.sub,
          type: 'task_completed',
          title: task?.title ?? 'Task completed',
          sourceType: 'task',
          sourceId: taskId,
        })
        .catch(() => undefined);
    }

    return { id: taskId, status, newAchievements };
  }
}
