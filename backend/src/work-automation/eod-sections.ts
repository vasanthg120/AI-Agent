import { EodAssessment, EodSections, TaskSnapshot } from './schemas/eod-report.schema';
import { DayView, TaskView } from './task-query.service';

const FOLLOW_UP_TYPES = new Set(['follow_up_reminder', 'email_reply_owed']);
const NEXT_DAY_LIMIT = 10;

export function snapshot(t: TaskView): TaskSnapshot {
  return {
    taskId: t.id,
    title: t.title,
    priority: t.priority,
    status: t.effectiveStatus,
    dueDate: t.dueDate,
    sourcePlatform: t.sourcePlatform,
    sourceType: t.sourceType,
    sourceUrl: t.sourceUrl,
    evidence: t.completionEvidence
      ? { type: t.completionEvidence.type, detail: t.completionEvidence.detail, at: t.completionEvidence.at, verifiedBy: t.completionEvidence.verifiedBy }
      : undefined,
  };
}

export interface ExtraFacts {
  meetings: EodSections['meetings'];
  repliesSent: number;
  crmUpdates: EodSections['crmUpdates'];
  /** Task actions the person themself took today (status changes, verification requests). */
  ownActions?: number;
  /** Whether every activity source (mail, CRM log) could be read. */
  activityReadable?: boolean;
  syncHealth?: EodAssessment['syncHealth'];
  syncNotes?: string[];
}

/**
 * Reads the day without turning missing data into a verdict on the person.
 * "sync_unreliable" wins whenever a source could not be read and nothing was
 * verifiably completed: with no data we cannot say "no work" or "no results".
 */
export function assess(counts: EodSections['counts'], extra: ExtraFacts): EodAssessment {
  const syncHealth = extra.syncHealth ?? 'ok';
  const openCount = counts.pending + counts.overdue + counts.blocked + counts.awaitingVerification;
  const assignedWork = openCount + counts.completed > 0;
  const completedWork = counts.completed > 0;
  const activityDetected = (extra.repliesSent ?? 0) > 0 || extra.crmUpdates.length > 0 || extra.meetings.items.length > 0 || (extra.ownActions ?? 0) > 0;
  const activitySignals = extra.meetings.source === 'outlook_calendar' && extra.activityReadable !== false ? 'complete' : 'partial';
  let headline: EodAssessment['headline'];
  if (completedWork) headline = 'worked';
  else if (syncHealth !== 'ok') headline = 'sync_unreliable';
  else if (assignedWork) headline = 'no_completed_work';
  else headline = 'no_assigned_work';
  return { headline, assignedWork, completedWork, activityDetected, activitySignals, syncHealth, syncNotes: extra.syncNotes ?? [] };
}

/** One plain sentence for the headline — never a productivity judgement. */
export function headlineSentence(a: EodAssessment, counts: EodSections['counts']): string {
  switch (a.headline) {
    case 'sync_unreliable':
      return 'This report cannot show what was assigned or done: at least one connected source could not be read or has not synchronized. It says nothing about the employee’s productivity.';
    case 'no_assigned_work':
      return a.activityDetected
        ? 'No work is assigned to this person in the connected platforms. Some activity was detected today (listed below).'
        : 'No work is assigned to this person in the connected platforms, and no activity was detected. This is not a statement about their productivity: work done outside the connected platforms is not visible here.';
    case 'no_completed_work':
      return `${counts.pending + counts.overdue + counts.blocked + counts.awaitingVerification} task(s) are assigned and none was completed with verified evidence today.${a.activityDetected ? ' Other activity was detected today (listed below).' : ' No other activity was detected.'}`;
    default:
      return '';
  }
}

/**
 * Turns one person's verified day into the report sections. Completed means
 * completed in the tracked data with its evidence; nothing is inferred. Open work
 * is split by its real state, and next-day priorities are the most urgent open
 * work (overdue first) — a ranking of existing tasks, not new commitments.
 */
export function buildSections(day: DayView, extra: ExtraFacts): EodSections {
  const openAll = [...day.overdue, ...day.open];
  const counts = {
    completed: day.completed.length,
    pending: day.open.filter((t) => t.status === 'pending' || t.status === 'in_progress').length,
    overdue: day.overdue.length,
    blocked: openAll.filter((t) => t.status === 'blocked').length,
    awaitingVerification: openAll.filter((t) => t.status === 'awaiting_verification').length,
  };
  const pending = day.open.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const blocked = openAll.filter((t) => t.status === 'blocked');
  const awaiting = openAll.filter((t) => t.status === 'awaiting_verification');
  const followUp = (t: TaskView) => FOLLOW_UP_TYPES.has(t.sourceType);
  return {
    completed: day.completed.map(snapshot),
    pending: pending.map(snapshot),
    overdue: day.overdue.map(snapshot),
    blocked: blocked.map(snapshot),
    awaitingVerification: awaiting.map(snapshot),
    meetings: extra.meetings,
    customerFollowUps: {
      repliesSent: extra.repliesSent,
      completed: day.completed.filter(followUp).map(snapshot),
      pending: openAll.filter(followUp).map(snapshot),
    },
    crmUpdates: extra.crmUpdates,
    nextDayPriorities: openAll.filter((t) => t.status !== 'awaiting_verification').slice(0, NEXT_DAY_LIMIT).map(snapshot),
    counts,
    assessment: assess(counts, extra),
  };
}

/** The narrative when the AI is unavailable (or not paid for): plain facts from the same sections. */
export function deterministicSummary(name: string, date: string, s: EodSections): string {
  const parts: string[] = [];
  const c = s.counts;
  if (s.assessment && s.assessment.headline !== 'worked') parts.push(headlineSentence(s.assessment, c));
  parts.push(`${name}'s end-of-day for ${date}: ${c.completed} task(s) completed, ${c.pending} pending, ${c.overdue} overdue${c.blocked ? `, ${c.blocked} blocked` : ''}${c.awaitingVerification ? `, ${c.awaitingVerification} awaiting verification` : ''}.`);
  if (s.customerFollowUps.repliesSent) parts.push(`${s.customerFollowUps.repliesSent} customer email repl${s.customerFollowUps.repliesSent === 1 ? 'y was' : 'ies were'} sent.`);
  if (s.meetings.items.length) parts.push(`${s.meetings.items.length} meeting(s) on the calendar.`);
  if (s.crmUpdates.length) parts.push(`${s.crmUpdates.length} CRM update(s) recorded.`);
  if (s.nextDayPriorities.length) parts.push(`Top next-day priorities: ${s.nextDayPriorities.slice(0, 3).map((t) => t.title).join('; ')}.`);
  return parts.join(' ');
}
