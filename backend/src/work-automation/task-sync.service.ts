import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CollectContext, CollectResult, SOURCE_ADAPTERS, TaskSourceAdapter } from './adapters/task-source-adapter';
import { AutomationConfigService } from './automation-config.service';
import { WorkSyncRun, WorkSyncRunDocument, WorkSyncState, WorkSyncStateDocument, SyncTrigger } from './schemas/work-sync.schema';
import { WorkTaskEvent, WorkTaskEventDocument, TaskEventType } from './schemas/work-task-event.schema';
import { WorkTask, WorkTaskDocument } from './schemas/work-task.schema';
import { SourceTask } from './task-types';

export interface ApplyCounts {
  fetched: number;
  created: number;
  updated: number;
  completed: number;
  deactivated: number;
  /** Source items whose assignee is not an active person of this organization — dropped, never assigned. */
  skippedAssignee: number;
}

export interface SyncOutcome {
  skipped?: 'disabled' | 'recently_synced' | 'already_running';
  runs: { adapterId: string; status: 'ok' | 'partial' | 'failed'; counts?: ApplyCounts; error?: string }[];
}

const LOCK_MS = 10 * 60 * 1000;
const sameTime = (a?: Date | null, b?: Date | null) => (a ? a.getTime() : null) === (b ? b.getTime() : null);

/**
 * Pulls assigned work from the registered source adapters into work_tasks.
 * Idempotent: a task is keyed by (organization, platform, type, source record id),
 * so any number of syncs — login, scheduled, final-before-EOD, overlapping —
 * converge on the same rows. The sync only ever changes what the source
 * owns (title, due date, priority, source status, assignee) and records
 * completion when the source itself proves it; statuses a person set
 * (in progress, blocked, awaiting verification) are never overwritten by it.
 */
@Injectable()
export class TaskSyncService {
  private readonly logger = new Logger(TaskSyncService.name);

  constructor(
    @InjectModel(WorkTask.name) private tasks: Model<WorkTaskDocument>,
    @InjectModel(WorkTaskEvent.name) private events: Model<WorkTaskEventDocument>,
    @InjectModel(WorkSyncRun.name) private runs: Model<WorkSyncRunDocument>,
    @InjectModel(WorkSyncState.name) private state: Model<WorkSyncStateDocument>,
    @InjectModel(User.name) private users: Model<UserDocument>,
    @Inject(SOURCE_ADAPTERS) private adapters: TaskSourceAdapter[],
    private config: AutomationConfigService,
  ) {}

  // ---- public entry points ----

  /** One employee's work, e.g. when they sign in. Skipped when synced within the organization's minimum interval (unless forced). */
  async syncUser(organizationId: string, userId: string, trigger: SyncTrigger, opts: { force?: boolean; now?: Date } = {}): Promise<SyncOutcome> {
    const cfg = await this.config.get(organizationId);
    if (!cfg.enabled) return { skipped: 'disabled', runs: [] };
    const interval = opts.force ? 0 : cfg.syncOnLoginMinIntervalMin * 60_000;
    const scope = `user:${userId}`;
    if (!(await this.claim(organizationId, scope, interval, opts.now))) return { skipped: interval ? 'recently_synced' : 'already_running', runs: [] };
    try {
      return { runs: await this.runAdapters({ organizationId, userId, trigger, now: opts.now ?? new Date(), config: cfg }) };
    } finally {
      await this.release(organizationId, scope);
    }
  }

  /** Everyone in the organization (scheduled sync, and the final sync before EOD). */
  async syncOrganization(organizationId: string, trigger: SyncTrigger, opts: { now?: Date } = {}): Promise<SyncOutcome> {
    const cfg = await this.config.get(organizationId);
    if (!cfg.enabled) return { skipped: 'disabled', runs: [] };
    if (!(await this.claim(organizationId, 'org', 0, opts.now))) return { skipped: 'already_running', runs: [] };
    try {
      return { runs: await this.runAdapters({ organizationId, trigger, now: opts.now ?? new Date(), config: cfg }) };
    } finally {
      await this.release(organizationId, 'org');
    }
  }

  // ---- claim / release (atomic, same idea as the store scheduler's claimEodRun) ----

  /** True only for the one caller whose write wins: no live lock and not started within `minIntervalMs`. */
  async claim(organizationId: string, scopeKey: string, minIntervalMs: number, nowArg?: Date): Promise<boolean> {
    const now = nowArg ?? new Date();
    try {
      const won = await this.state
        .findOneAndUpdate(
          {
            organizationId,
            scopeKey,
            $and: [
              { $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
              { $or: [{ lastStartedAt: { $exists: false } }, { lastStartedAt: { $lte: new Date(now.getTime() - minIntervalMs) } }] },
            ],
          },
          { $set: { lastStartedAt: now, lockedUntil: new Date(now.getTime() + LOCK_MS) } },
          { upsert: true, new: true },
        )
        .exec();
      return !!won;
    } catch (err) {
      // The row exists but the guard did not match (locked or too recent): somebody else owns this run.
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async release(organizationId: string, scopeKey: string): Promise<void> {
    await this.state.updateOne({ organizationId, scopeKey }, { $set: { lastFinishedAt: new Date() }, $unset: { lockedUntil: '' } }).exec();
  }

  // ---- adapter loop ----

  private async runAdapters(args: { organizationId: string; userId?: string; trigger: SyncTrigger; now: Date; config: CollectContext['config'] }): Promise<SyncOutcome['runs']> {
    const out: SyncOutcome['runs'] = [];
    const enabled = this.adapters.filter((a) => args.config.enabledSources.includes(a.id));
    const timezone = await this.config.effectiveTimezone(args.organizationId, args.config);
    for (const adapter of enabled) {
      const startedAt = new Date();
      try {
        const result = await adapter.collect({ organizationId: args.organizationId, userId: args.userId, now: args.now, config: args.config, timezone });
        const counts = await this.applyBatch(args.organizationId, adapter, result, args.userId, `sync:${adapter.id}`, args.now);
        const status = result.complete ? 'ok' : 'partial';
        await this.recordRun(args, adapter.id, status, startedAt, { ...counts, unresolved: result.unresolved });
        out.push({ adapterId: adapter.id, status, counts });
      } catch (err) {
        // One failing integration must not stop the others; the failure is visible on the admin monitor.
        const message = (err as Error).message;
        this.logger.error(`Sync "${adapter.id}" failed for org ${args.organizationId}: ${message}`);
        await this.recordRun(args, adapter.id, 'failed', startedAt, undefined, message).catch(() => undefined);
        out.push({ adapterId: adapter.id, status: 'failed', error: message });
      }
    }
    return out;
  }

  private async recordRun(
    args: { organizationId: string; userId?: string; trigger: SyncTrigger },
    adapterId: string,
    status: 'ok' | 'partial' | 'failed',
    startedAt: Date,
    counts?: Partial<ApplyCounts> & { unresolved?: number },
    error?: string,
  ) {
    await this.runs.create({
      organizationId: args.organizationId,
      userId: args.userId,
      adapterId,
      trigger: args.trigger,
      status,
      startedAt,
      finishedAt: new Date(),
      fetched: counts?.fetched ?? 0,
      created: counts?.created ?? 0,
      updated: counts?.updated ?? 0,
      completed: counts?.completed ?? 0,
      deactivated: counts?.deactivated ?? 0,
      unresolved: counts?.unresolved ?? 0,
      error: error?.slice(0, 500),
    });
  }

  // ---- the idempotent upsert ----

  async applyBatch(organizationId: string, adapter: TaskSourceAdapter, result: CollectResult, scopeUserId: string | undefined, actor: string, now: Date): Promise<ApplyCounts> {
    const counts: ApplyCounts = { fetched: result.tasks.length, created: 0, updated: 0, completed: 0, deactivated: 0, skippedAssignee: 0 };

    // Only active people of THIS organization can be assigned work, whatever the source claims.
    const assignees = [...new Set(result.tasks.map((t) => t.assignedTo))];
    const valid = new Set<string>(
      assignees.length ? (await this.users.find({ _id: { $in: assignees }, organizationId, active: true }).select('_id').lean().exec()).map((u) => u._id.toString()) : [],
    );

    const seen = new Set<string>();
    for (const t of result.tasks) {
      if (!valid.has(t.assignedTo)) {
        counts.skippedAssignee += 1;
        continue;
      }
      seen.add(keyOf(t));
      await this.applyOne(organizationId, t, actor, now, counts);
    }

    if (result.complete) {
      const live = await this.tasks
        .find({
          organizationId,
          sourceType: { $in: [...adapter.sourceTypes] },
          isActive: true,
          status: { $ne: 'completed' },
          ...(scopeUserId ? { assignedTo: scopeUserId } : {}),
        })
        .exec();
      for (const task of live) {
        if (seen.has(keyOf(task))) continue;
        await this.deactivate(task, 'no_longer_actionable_in_source', actor, now);
        counts.deactivated += 1;
      }
    }
    return counts;
  }

  private async applyOne(organizationId: string, t: SourceTask, actor: string, now: Date, counts: ApplyCounts): Promise<void> {
    const natural = { organizationId, sourcePlatform: t.sourcePlatform, sourceType: t.sourceType, sourceRecordId: t.sourceRecordId };
    let existing = await this.tasks.findOne(natural).exec();

    if (t.state === 'closed') {
      // Closed history never creates a task: it only finishes one Haive was already tracking.
      if (!existing || !t.closure) return;
      if (t.closure.kind === 'completed') {
        if (existing.status === 'completed') return;
        const evidence = t.closure.evidence;
        const from = existing.status;
        await this.tasks.updateOne({ _id: existing._id }, { $set: { status: 'completed', completionEvidence: evidence, completedAt: evidence.at, isActive: true, lastSyncedAt: now, sourceStatus: t.sourceStatus }, $unset: { inactiveReason: '' } }).exec();
        await this.log(existing, 'completed', actor, from, 'completed', evidence.detail);
        counts.completed += 1;
      } else if (existing.isActive && existing.status !== 'completed') {
        await this.deactivate(existing, t.closure.reason, actor, now);
        counts.deactivated += 1;
      }
      return;
    }

    if (!existing) {
      try {
        const created = await this.tasks.create({
          ...natural,
          assignedTo: t.assignedTo,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueDate: t.dueDate,
          status: 'pending',
          isActive: true,
          sourceUrl: t.sourceUrl,
          sourceStatus: t.sourceStatus,
          sourceUpdatedAt: t.sourceUpdatedAt,
          firstSyncedAt: now,
          lastSyncedAt: now,
          lastSeenOpenAt: now,
          meta: t.meta ?? {},
        });
        await this.log(created, 'created', actor, undefined, 'pending', t.title);
        counts.created += 1;
        return;
      } catch (err) {
        // A concurrent sync created the same task first: continue as an update of that one.
        if ((err as { code?: number }).code !== 11000) throw err;
        existing = await this.tasks.findOne(natural).exec();
        if (!existing) throw err;
      }
    }

    const set: Record<string, unknown> = { lastSyncedAt: now, lastSeenOpenAt: now };
    const unset: Record<string, ''> = {};
    let changed = false;

    if (existing.assignedTo !== t.assignedTo) {
      set.assignedTo = t.assignedTo;
      await this.log(existing, 'reassigned', actor, existing.assignedTo, t.assignedTo, 'Assignee changed in the source.');
      changed = true;
    }
    for (const [field, next] of [['title', t.title], ['description', t.description], ['priority', t.priority], ['sourceStatus', t.sourceStatus], ['sourceUrl', t.sourceUrl]] as const) {
      if ((existing as unknown as Record<string, unknown>)[field] !== next && next !== undefined) {
        set[field] = next;
        changed = true;
      }
    }
    if (!sameTime(existing.dueDate, t.dueDate ?? null)) {
      if (t.dueDate) set.dueDate = t.dueDate;
      else unset.dueDate = '';
      changed = true;
    }
    if (t.sourceUpdatedAt) set.sourceUpdatedAt = t.sourceUpdatedAt;
    if (t.meta) set.meta = { ...((existing as unknown as { meta?: Record<string, unknown> }).meta ?? {}), ...t.meta };

    if (!existing.isActive) {
      set.isActive = true;
      unset.inactiveReason = '';
      await this.log(existing, 'reactivated', actor, existing.inactiveReason, true, 'The source lists it as open again.');
      changed = true;
    }
    // The source says it is open again after we recorded it done: the source is the truth,
    // unless a person confirmed it and the source has not changed since.
    if (existing.status === 'completed') {
      const manual = existing.completionEvidence?.type === 'manual_verified';
      const sourceMovedOn = !!t.sourceUpdatedAt && !!existing.completedAt && t.sourceUpdatedAt.getTime() > existing.completedAt.getTime();
      if (!manual || sourceMovedOn) {
        set.status = 'pending';
        unset.completionEvidence = '';
        unset.completedAt = '';
        await this.log(existing, 'status_changed', actor, 'completed', 'pending', 'Reopened: the source shows it open again.');
        changed = true;
      }
    }

    await this.tasks.updateOne({ _id: existing._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }).exec();
    if (changed) {
      counts.updated += 1;
      await this.log(existing, 'updated', actor, undefined, undefined, 'Details refreshed from the source.');
    }
  }

  private async deactivate(task: WorkTaskDocument, reason: string, actor: string, now: Date) {
    await this.tasks.updateOne({ _id: task._id }, { $set: { isActive: false, inactiveReason: reason, lastSyncedAt: now } }).exec();
    await this.log(task, 'deactivated', actor, true, false, reason);
  }

  private async log(task: Pick<WorkTaskDocument, '_id' | 'organizationId' | 'assignedTo'>, type: TaskEventType, actor: string, from?: unknown, to?: unknown, note?: string) {
    await this.events.create({ organizationId: task.organizationId, taskId: task._id.toString(), userId: task.assignedTo, type, actor, from, to, note });
  }
}

const keyOf = (t: { sourcePlatform: string; sourceType: string; sourceRecordId: string }) => `${t.sourcePlatform}|${t.sourceType}|${t.sourceRecordId}`;
