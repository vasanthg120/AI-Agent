import type { BadgeVariant } from '@/components/ui';
import type { EodAssessment, EodDeliveryRow, HierarchyPerson, ReportState, WorkAction, WorkEffectiveStatus, WorkPriority, WorkTask } from '@/services/workAutomationService';

export const STATUS_LABEL: Record<WorkEffectiveStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  overdue: 'Overdue',
  blocked: 'Blocked',
  awaiting_verification: 'Awaiting verification',
};

export const STATUS_VARIANT: Record<WorkEffectiveStatus, BadgeVariant> = {
  pending: 'neutral',
  in_progress: 'info',
  completed: 'success',
  overdue: 'danger',
  blocked: 'warning',
  awaiting_verification: 'accent',
};

export const PRIORITY_VARIANT: Record<WorkPriority, BadgeVariant> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };

export const REPORT_STATE_LABEL: Record<ReportState, string> = {
  generated: 'Generated',
  failed: 'Failed',
  generating: 'Generating',
  missing: 'Missing',
  not_due: 'Not due yet',
  no_work: 'Not required',
};

export const REPORT_STATE_VARIANT: Record<ReportState, BadgeVariant> = {
  generated: 'success',
  failed: 'danger',
  generating: 'info',
  missing: 'danger',
  not_due: 'neutral',
  no_work: 'neutral',
};

export const DELIVERY_VARIANT: Record<EodDeliveryRow['status'], BadgeVariant> = {
  pending: 'neutral',
  sending: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
};

const SKIP_REASON: Record<string, string> = {
  no_manager_configured: 'No reporting manager is set for this person.',
  manager_not_valid: 'The configured manager is not an active person of this business.',
  manager_changed_or_inactive: 'The manager changed or was deactivated before sending.',
  employee_has_no_email: 'The employee has no email address.',
  no_recipient: 'No recipient address.',
};

export const skipReasonLabel = (reason?: string): string => (reason ? (SKIP_REASON[reason] ?? reason.replace(/_/g, ' ')) : '');

const PLATFORM_LABEL: Record<string, string> = { pantheras: 'Pantheras', hoops: 'Hoops', outlook: 'Outlook', gmail: 'Gmail', haive: 'Haive' };
export const platformLabel = (p: string): string => PLATFORM_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

const EVIDENCE_LABEL: Record<string, string> = { source_status: 'Confirmed by the source', source_event: 'Recorded in the source', manual_verified: 'Verified by a person' };
export const evidenceLabel = (type: string): string => EVIDENCE_LABEL[type] ?? type;

/** What a person (or a manager) may do next with a task, from its status and who is looking. Mirrors the server rules; the server still enforces them. */
export function availableActions(task: Pick<WorkTask, 'status'>, who: { isAssignee: boolean; canVerify: boolean }): { action: WorkAction; label: string; needsNote: boolean }[] {
  const out: { action: WorkAction; label: string; needsNote: boolean }[] = [];
  if (who.isAssignee) {
    if (task.status === 'pending' || task.status === 'blocked') out.push({ action: 'start', label: 'Start', needsNote: false });
    if (task.status === 'pending' || task.status === 'in_progress') out.push({ action: 'block', label: 'Mark blocked', needsNote: true });
    if (task.status === 'blocked') out.push({ action: 'unblock', label: 'Unblock', needsNote: false });
    if (task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked') out.push({ action: 'request_verification', label: 'Request verification', needsNote: true });
  }
  if (who.canVerify) {
    if (task.status === 'awaiting_verification') {
      out.push({ action: 'verify', label: 'Verify done', needsNote: true });
      out.push({ action: 'reject_verification', label: 'Send back', needsNote: true });
    }
    if (task.status === 'completed') out.push({ action: 'reopen', label: 'Reopen', needsNote: true });
  }
  return out;
}

/** People who could become `userId`'s manager: active, not themself, and not anyone who already reports (directly or not) to them. */
export function managerCandidates(people: HierarchyPerson[], userId: string): HierarchyPerson[] {
  const below = new Set<string>();
  const queue = [userId];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const p of people) {
      if (p.reportingManagerId === current && !below.has(p.id) && p.id !== userId) {
        below.add(p.id);
        queue.push(p.id);
      }
    }
  }
  return people.filter((p) => p.active && p.id !== userId && !below.has(p.id));
}

/** Whole-day label of a due date, e.g. "Due 24 Nov" or "Overdue by 2 days". */
export function dueLabel(dueDate: string | undefined, now: Date = new Date()): string {
  if (!dueDate) return '';
  const due = new Date(dueDate);
  const days = Math.floor((now.getTime() - due.getTime()) / 86_400_000);
  if (days >= 1) return `Overdue by ${days} day${days === 1 ? '' : 's'}`;
  return `Due ${due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** The one-line reading of a report's day, in the same words the email uses. Never a productivity judgement. */
export function assessmentSentence(a: EodAssessment | undefined, pendingCount = 0): string {
  if (!a) return '';
  switch (a.headline) {
    case 'sync_unreliable':
      return 'This report cannot show what was assigned or done: a connected source could not be read or has not synchronized. It says nothing about the employee’s productivity.';
    case 'no_assigned_work':
      return a.activityDetected
        ? 'No work is assigned to this person in the connected platforms. Some activity was detected today.'
        : 'No work is assigned to this person in the connected platforms, and no activity was detected. Work done outside the connected platforms is not visible here.';
    case 'no_completed_work':
      return `${pendingCount} task(s) are assigned and none was completed with verified evidence today.`;
    default:
      return '';
  }
}
