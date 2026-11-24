import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { WorkTaskEvent, WorkTaskEventDocument } from './schemas/work-task-event.schema';
import { WorkTask, WorkTaskDocument } from './schemas/work-task.schema';
import { LIFECYCLE_ACTIONS, LIFECYCLE_RULES, LifecycleAction, nextStatus } from './task-lifecycle';
import { WorkAccessService } from './work-access.service';

export { LIFECYCLE_ACTIONS };

/**
 * Employee- and manager-driven status changes. The sync owns source facts and
 * source-proven completion; this owns the human part, and the rule that a task
 * only becomes completed by (a) its source proving it, or (b) a verifier
 * confirming it with a note. Every change is checked against the task's current
 * status in the write itself, so two people acting at once cannot both win.
 */
@Injectable()
export class TaskLifecycleService {
  constructor(
    @InjectModel(WorkTask.name) private tasks: Model<WorkTaskDocument>,
    @InjectModel(WorkTaskEvent.name) private events: Model<WorkTaskEventDocument>,
    private access: WorkAccessService,
  ) {}

  async act(caller: JwtPayload, taskId: string, action: LifecycleAction, note?: string): Promise<WorkTaskDocument> {
    const rule = LIFECYCLE_RULES[action];
    if (!rule) throw new BadRequestException('Unknown action.');
    if (!isValidObjectId(taskId)) throw new NotFoundException('Task not found.');
    const task = await this.tasks.findOne({ _id: taskId, organizationId: caller.organizationId, isActive: true }).exec();
    if (!task) throw new NotFoundException('Task not found.');

    const trimmed = note?.trim();
    if (rule.needsNote && !trimmed) throw new BadRequestException('Add a short note explaining this.');

    if (rule.by === 'assignee') {
      if (task.assignedTo !== caller.sub) throw new ForbiddenException('Only the person this task is assigned to can do that.');
    } else if (!(await this.access.canVerify(caller, task.assignedTo))) {
      throw new ForbiddenException('Only a manager of this person, or an admin, can do that.');
    }

    let to;
    try {
      to = nextStatus(task.status, action);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const now = new Date();
    const set: Record<string, unknown> = { status: to };
    const unset: Record<string, ''> = {};
    if (action === 'verify') {
      set.completionEvidence = { type: 'manual_verified', detail: trimmed, at: now, verifiedBy: caller.sub };
      set.completedAt = now;
    } else if (action === 'reopen') {
      unset.completionEvidence = '';
      unset.completedAt = '';
    }
    // The status in the filter is the guard: if it moved since we read it, nothing is written.
    const updated = await this.tasks
      .findOneAndUpdate({ _id: taskId, organizationId: caller.organizationId, status: task.status }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true })
      .exec();
    if (!updated) throw new BadRequestException('This task was just changed by someone else. Refresh and try again.');

    await this.events.create({
      organizationId: caller.organizationId,
      taskId,
      userId: task.assignedTo,
      type: action === 'verify' ? 'completed' : action === 'request_verification' ? 'verification_requested' : 'status_changed',
      actor: caller.sub,
      from: task.status,
      to,
      note: trimmed,
    });
    return updated;
  }
}
