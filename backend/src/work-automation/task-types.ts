// Shared vocabulary of the automatic To-Do & EOD system.

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Stored lifecycle. "Overdue" is not stored: it is derived from dueDate on read
// (see task-lifecycle.ts effectiveStatus) so it can never go stale.
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'awaiting_verification'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type EffectiveTaskStatus = TaskStatus | 'overdue';

// What proves a task is done. AI inference is deliberately not a type.
//  source_status   – the source platform itself now says it is done/closed
//  source_event    – a recorded fact in the source (a reply sent, a payment recorded)
//  manual_verified – a named person with the right to confirmed it in Haive
export const EVIDENCE_TYPES = ['source_status', 'source_event', 'manual_verified'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface CompletionEvidence {
  type: EvidenceType;
  detail: string;
  at: Date;
  sourceRef?: string;
  verifiedBy?: string;
}

/** One actionable item as a source platform reports it, before it becomes (or updates) a work task. */
export interface SourceTask {
  sourcePlatform: string;
  sourceType: string;
  sourceRecordId: string;
  assignedTo: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  dueDate?: Date;
  sourceStatus?: string;
  /** Adapter-private facts carried with the task (e.g. the last Gmail message id), kept for the next sync. */
  meta?: Record<string, unknown>;
  /** In-app path of the record (e.g. "/ai-email-inbox"); the full URL is built from the app's base URL. */
  sourceUrl?: string;
  sourceUpdatedAt?: Date;
  /** open: still to do. closed: the source says it is finished or no longer needed. */
  state: 'open' | 'closed';
  /** Present when state is 'closed'. completed needs evidence; withdrawn (dismissed, reassigned, not needed) never counts as work done. */
  closure?: { kind: 'completed'; evidence: CompletionEvidence } | { kind: 'withdrawn'; reason: string };
}

export interface AutomationConfigValues {
  enabled: boolean;
  /** "HH:mm" wall-clock time in `timezone` at which each employee's EOD report is generated. */
  eodTime: string;
  /** IANA zone; empty means the organization's own timezone. */
  timezone: string;
  /** Source adapter ids that feed the To-Do list. */
  enabledSources: string[];
  /** CRM providers (data-source provider ids) whose deals and quotes become tasks. */
  crmProviders: string[];
  /** A deal with no activity for this many days becomes a follow-up task. */
  staleDealDays: number;
  /** A deal expected to close within this many days (or already past) becomes a task. */
  dealCloseWindowDays: number;
  /** A quote payment due within this many days (or already late) becomes a task. */
  quoteDueWindowDays: number;
  /** How far back unanswered customer emails are considered. */
  emailLookbackDays: number;
  /** Minimum minutes between two login-triggered syncs of the same employee. */
  syncOnLoginMinIntervalMin: number;
  /** Send the employee's own report to their reporting manager as well. */
  sendToManager: boolean;
  /** Preferred sending channel order; smtp is the configured fallback. */
  deliveryChannels: ('gmail' | 'outlook' | 'smtp')[];
  maxDeliveryAttempts: number;
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfigValues = {
  enabled: true,
  eodTime: '18:00',
  timezone: '',
  enabledSources: ['crm', 'email'],
  crmProviders: ['prospectconnect', 'hoops'],
  staleDealDays: 7,
  dealCloseWindowDays: 7,
  quoteDueWindowDays: 3,
  emailLookbackDays: 7,
  syncOnLoginMinIntervalMin: 15,
  sendToManager: true,
  deliveryChannels: ['gmail', 'outlook', 'smtp'],
  maxDeliveryAttempts: 3,
};
