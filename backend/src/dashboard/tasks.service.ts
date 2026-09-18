import { HttpService } from '@nestjs/axios';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { firstValueFrom } from 'rxjs';
import { Model, Types } from 'mongoose';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Achievement } from '../gamification/achievements';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
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

export interface TaskRecommendation {
  taskId: string;
  rationale: string;
}

interface RecommendTasksResult {
  recommendations: TaskRecommendation[];
  overallNote: string;
}

@Injectable()
export class TasksService {
  private readonly agentUrl: string;

  constructor(
    @InjectModel(DailyReport.name) private reportModel: Model<DailyReportDocument>,
    private chatService: ChatService,
    private http: HttpService,
    private config: ConfigService,
    private jwt: JwtService,
    private gamificationService: GamificationService,
    private timelineService: TimelineService,
  ) {
    this.agentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

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
  // whatever they'd actually see if they clicked into that day.
  async calendarSummary(month: string, caller: JwtPayload, mine = true) {
    const allowedAgentIds = await resolveAllowedAgentIds(this.chatService, caller);
    const reports = await this.reportModel
      .find({ organizationId: caller.organizationId, agentId: { $in: allowedAgentIds }, date: { $regex: `^${month}` } })
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

  /** Next-best-action shortlist over today's open tasks — reuses list()'s
   * existing RBAC scoping/date-defaulting rather than re-implementing it, so
   * there's exactly one place that decides "today" and "which agents".
   * Filters the model's response to taskIds that actually exist in the
   * scoped list — defends against a hallucinated id turning into a
   * recommendation card with no underlying task to show. */
  async getRecommendations(caller: JwtPayload): Promise<{ recommendations: (TaskRecommendation & { task: TaskOut })[]; overallNote: string }> {
    const { tasks } = await this.list({}, caller);
    const openTasks = tasks.filter((t) => t.status !== 'done');
    if (openTasks.length === 0) {
      return { recommendations: [], overallNote: 'Nothing open right now.' };
    }

    const userJwt = this.jwt.sign({ sub: caller.sub }, { expiresIn: '5m' });
    const { data } = await firstValueFrom(
      this.http.post<RecommendTasksResult>(
        `${this.agentUrl}/tasks/recommend`,
        { tasks: openTasks.map((t) => ({ id: t.id, title: t.title, priority: t.priority, isOverdue: t.isOverdue, category: t.category })) },
        { headers: { Authorization: `Bearer ${userJwt}` } },
      ),
    );

    const byId = new Map(openTasks.map((t) => [t.id, t]));
    const recommendations = data.recommendations
      .filter((r) => byId.has(r.taskId))
      .map((r) => ({ ...r, task: byId.get(r.taskId)! }));
    return { recommendations, overallNote: data.overallNote };
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
