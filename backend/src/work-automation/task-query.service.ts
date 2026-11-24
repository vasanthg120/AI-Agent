import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { businessDayOf, businessDayRange } from '../common/business-day';
import { AutomationConfigService } from './automation-config.service';
import { WorkTaskEvent, WorkTaskEventDocument } from './schemas/work-task-event.schema';
import { WorkTask, WorkTaskDocument } from './schemas/work-task.schema';
import { effectiveStatus } from './task-lifecycle';
import { CompletionEvidence, EffectiveTaskStatus, TaskPriority, TaskStatus } from './task-types';

export interface TaskView {
  id: string;
  assignedTo: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  dueDate?: Date;
  status: TaskStatus;
  effectiveStatus: EffectiveTaskStatus;
  sourcePlatform: string;
  sourceType: string;
  sourceRecordId: string;
  sourceUrl?: string;
  sourceStatus?: string;
  lastSyncedAt?: Date;
  completedAt?: Date;
  completionEvidence?: CompletionEvidence;
}

export interface DayView {
  userId: string;
  date: string;
  timezone: string;
  /** Open work that is not yet late (pending, in progress, blocked, awaiting verification). */
  open: TaskView[];
  overdue: TaskView[];
  /** Completed on this business day, each with its evidence. */
  completed: TaskView[];
  counts: { open: number; overdue: number; completed: number; blocked: number; awaitingVerification: number };
}

export interface ActivityView {
  at: Date;
  type: string;
  actor: string;
  taskId: string;
  taskTitle?: string;
  note?: string;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const byUrgency = (a: TaskView, b: TaskView) =>
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity) || a.title.localeCompare(b.title);

export function toTaskView(t: WorkTaskDocument, now: Date): TaskView {
  return {
    id: String(t._id),
    assignedTo: t.assignedTo,
    title: t.title,
    description: t.description,
    priority: t.priority,
    dueDate: t.dueDate,
    status: t.status,
    effectiveStatus: effectiveStatus(t, now),
    sourcePlatform: t.sourcePlatform,
    sourceType: t.sourceType,
    sourceRecordId: t.sourceRecordId,
    sourceUrl: t.sourceUrl,
    sourceStatus: t.sourceStatus,
    lastSyncedAt: t.lastSyncedAt,
    completedAt: t.completedAt,
    completionEvidence: t.completionEvidence,
  };
}

/** Read side of the work tasks. Callers must already have checked the viewer may see `userId` (WorkAccessService). */
@Injectable()
export class TaskQueryService {
  constructor(
    @InjectModel(WorkTask.name) private tasks: Model<WorkTaskDocument>,
    @InjectModel(WorkTaskEvent.name) private events: Model<WorkTaskEventDocument>,
    private config: AutomationConfigService,
  ) {}

  /** One person's board for one business day (default: today in the organization's timezone). */
  async dayView(organizationId: string, userId: string, opts: { date?: string; now?: Date } = {}): Promise<DayView> {
    const now = opts.now ?? new Date();
    const timezone = await this.config.effectiveTimezone(organizationId);
    const date = opts.date ?? businessDayOf(timezone, now);
    const { start, end } = businessDayRange(timezone, date, date);

    const live = await this.tasks.find({ organizationId, assignedTo: userId, isActive: true, status: { $ne: 'completed' } }).limit(1000).exec();
    const done = await this.tasks.find({ organizationId, assignedTo: userId, status: 'completed', completedAt: { $gte: start, $lt: end } }).limit(500).exec();

    // For a past day, work that was due later than that day is not "overdue" on it.
    const asOf = end.getTime() < now.getTime() ? end : now;
    const views = live.map((t) => toTaskView(t, asOf));
    const overdue = views.filter((v) => v.effectiveStatus === 'overdue').sort(byUrgency);
    const open = views.filter((v) => v.effectiveStatus !== 'overdue').sort(byUrgency);
    const completed = done.map((t) => toTaskView(t, now)).sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

    return {
      userId,
      date,
      timezone,
      open,
      overdue,
      completed,
      counts: {
        open: open.length + overdue.length,
        overdue: overdue.length,
        completed: completed.length,
        blocked: views.filter((v) => v.status === 'blocked').length,
        awaitingVerification: views.filter((v) => v.status === 'awaiting_verification').length,
      },
    };
  }

  /** What happened to this person's work on a business day, newest first (Today's activities). */
  async activity(organizationId: string, userId: string, opts: { date?: string; now?: Date } = {}): Promise<ActivityView[]> {
    const timezone = await this.config.effectiveTimezone(organizationId);
    const date = opts.date ?? businessDayOf(timezone, opts.now ?? new Date());
    const { start, end } = businessDayRange(timezone, date, date);
    const rows = await this.events.find({ organizationId, userId, at: { $gte: start, $lt: end } }).sort({ at: -1 }).limit(200).exec();
    const ids = [...new Set(rows.map((r) => r.taskId))];
    const titles = new Map<string, string>();
    if (ids.length) for (const t of await this.tasks.find({ organizationId, _id: { $in: ids } }).exec()) titles.set(String(t._id), t.title);
    return rows
      // Pure refreshes from the source are noise in a person's day.
      .filter((r) => r.type !== 'updated')
      .map((r) => ({ at: r.at, type: r.type, actor: r.actor, taskId: r.taskId, taskTitle: titles.get(r.taskId), note: r.note }));
  }

  /** Everyone who has open tracked work, or finished tracked work in [start, end). */
  async assigneesWithWork(organizationId: string, start: Date, end: Date): Promise<string[]> {
    const open = await this.tasks.find({ organizationId, isActive: true, status: { $ne: 'completed' } }).select('assignedTo').limit(20000).lean().exec();
    const done = await this.tasks.find({ organizationId, status: 'completed', completedAt: { $gte: start, $lt: end } }).select('assignedTo').limit(20000).lean().exec();
    return [...new Set([...open, ...done].map((t) => t.assignedTo))];
  }

  /** Counts for a set of people (manager dashboard). */
  async teamCounts(organizationId: string, userIds: string[], opts: { now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const timezone = await this.config.effectiveTimezone(organizationId);
    const { start, end } = businessDayRange(timezone, businessDayOf(timezone, now), businessDayOf(timezone, now));
    const live = userIds.length ? await this.tasks.find({ organizationId, assignedTo: { $in: userIds }, isActive: true, status: { $ne: 'completed' } }).limit(5000).exec() : [];
    const done = userIds.length ? await this.tasks.find({ organizationId, assignedTo: { $in: userIds }, status: 'completed', completedAt: { $gte: start, $lt: end } }).limit(5000).exec() : [];
    const out = new Map<string, { open: number; overdue: number; completedToday: number; blocked: number; awaitingVerification: number }>();
    for (const id of userIds) out.set(id, { open: 0, overdue: 0, completedToday: 0, blocked: 0, awaitingVerification: 0 });
    for (const t of live) {
      const row = out.get(t.assignedTo);
      if (!row) continue;
      if (effectiveStatus(t, now) === 'overdue') row.overdue += 1;
      row.open += 1;
      if (t.status === 'blocked') row.blocked += 1;
      if (t.status === 'awaiting_verification') row.awaitingVerification += 1;
    }
    for (const t of done) {
      const row = out.get(t.assignedTo);
      if (row) row.completedToday += 1;
    }
    return out;
  }
}
