import { EffectiveTaskStatus, TaskStatus } from './task-types';

// Statuses in which a task is still open work (can become overdue).
const OPEN: ReadonlySet<TaskStatus> = new Set(['pending', 'in_progress', 'blocked', 'awaiting_verification']);

export function isOpenStatus(status: TaskStatus): boolean {
  return OPEN.has(status);
}

/** The status a person sees: open work past its due date reads "overdue". Derived on every read, never stored. */
export function effectiveStatus(task: { status: TaskStatus; dueDate?: Date | null }, now: Date): EffectiveTaskStatus {
  if (task.status === 'completed') return 'completed';
  if (task.dueDate && isOpenStatus(task.status) && task.dueDate.getTime() < now.getTime()) return 'overdue';
  return task.status;
}

// ---- manual lifecycle actions ----
// People move work between pending / in progress / blocked and ask for it to be
// verified. Only a verifier (an admin/owner, or the assignee's manager) can mark
// it completed, and only with a recorded note. Nothing here lets an employee —
// or an AI — complete a task on their own say-so.

export const LIFECYCLE_ACTIONS = ['start', 'block', 'unblock', 'request_verification', 'reject_verification', 'verify', 'reopen'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

interface Rule {
  from: readonly TaskStatus[];
  to: TaskStatus;
  /** assignee: the person the work belongs to. verifier: someone with authority over them. */
  by: 'assignee' | 'verifier';
  /** The action must carry a written note (what blocks it / what was done / how it was checked). */
  needsNote: boolean;
}

export const LIFECYCLE_RULES: Record<LifecycleAction, Rule> = {
  start: { from: ['pending', 'blocked'], to: 'in_progress', by: 'assignee', needsNote: false },
  block: { from: ['pending', 'in_progress'], to: 'blocked', by: 'assignee', needsNote: true },
  unblock: { from: ['blocked'], to: 'pending', by: 'assignee', needsNote: false },
  request_verification: { from: ['pending', 'in_progress', 'blocked'], to: 'awaiting_verification', by: 'assignee', needsNote: true },
  reject_verification: { from: ['awaiting_verification'], to: 'in_progress', by: 'verifier', needsNote: true },
  verify: { from: ['awaiting_verification'], to: 'completed', by: 'verifier', needsNote: true },
  reopen: { from: ['completed'], to: 'in_progress', by: 'verifier', needsNote: true },
};

/** The status an action leads to, or throws a plain-language error when it is not allowed from here. */
export function nextStatus(from: TaskStatus, action: LifecycleAction): TaskStatus {
  const rule = LIFECYCLE_RULES[action];
  if (!rule) throw new Error('Unknown action.');
  if (!rule.from.includes(from)) throw new Error(`A task that is ${from.replace('_', ' ')} can’t be moved this way.`);
  return rule.to;
}
