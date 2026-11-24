import { Injectable } from '@nestjs/common';
import { deriveRespondedInfo, deriveResponseStatus } from '../../email-intelligence/email-response-state';
import { SourceTask, TaskPriority } from '../task-types';
import { addDays, CollectContext, CollectResult, endOfBusinessDay, MAX_SOURCE_ROWS, RecordReader, TaskSourceAdapter } from './task-source-adapter';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_LOOKBACK_DAYS = 3;
const EMAIL_PLATFORM = 'outlook'; // Email Intelligence reads Microsoft Graph mailboxes.
const EMAIL_URL = '/ai-email-inbox';

const PRIORITY: Record<string, TaskPriority> = { urgent: 'urgent', high: 'high', medium: 'medium', low: 'low' };
const pri = (v: unknown): TaskPriority => PRIORITY[String(v ?? '').toLowerCase()] ?? 'medium';

/**
 * The existing Email Intelligence data: follow-up reminders and customer emails
 * that are still owed a reply. The mailbox owner (userId) is the assignee, which
 * is the mailbox connection itself — a verified identity, so no name matching.
 * Only messages the AI classified as needing a company reply count; newsletters,
 * "no reply needed" mail and meeting noise never become tasks. A task is closed
 * only by a recorded reply (sentAt / detected reply / later thread reply) or by
 * the reminder being marked done in the source.
 *
 * Gmail is not covered: Email Intelligence itself only ingests Outlook today.
 */
@Injectable()
export class EmailTaskAdapter implements TaskSourceAdapter {
  readonly id = 'email';
  readonly label = 'Email follow-ups & replies owed';
  readonly sourceTypes = ['follow_up_reminder', 'email_reply_owed'] as const;
  readonly description = 'Follow-up reminders and customer emails still waiting for a reply, from the connected Outlook mailbox of the employee (Email Intelligence).';

  constructor(private reader: RecordReader) {}

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const tasks: SourceTask[] = [];
    let complete = true;
    const closedSince = new Date(ctx.now.getTime() - CLOSED_LOOKBACK_DAYS * DAY_MS);
    const user: Record<string, unknown> = ctx.userId ? { userId: ctx.userId } : {};

    // ---- follow-up reminders ----
    const reminders = await this.reader.find(
      'email_follow_up_reminders',
      { organizationId: ctx.organizationId, ...user, $or: [{ status: 'pending' }, { status: { $in: ['done', 'dismissed'] }, updatedAt: { $gte: closedSince } }] },
      { limit: MAX_SOURCE_ROWS, sort: { dueDate: 1 } },
    );
    if (reminders.length >= MAX_SOURCE_ROWS) complete = false;
    const todayEnd = endOfBusinessDay(ctx.timezone, ctx.now);
    for (const r of reminders) {
      const common = {
        sourcePlatform: EMAIL_PLATFORM,
        sourceType: 'follow_up_reminder',
        sourceRecordId: String(r._id),
        assignedTo: String(r.userId),
        sourceUrl: EMAIL_URL,
        sourceUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : undefined,
        title: String(r.title ?? 'Follow up'),
        description: r.businessName ? `Customer: ${r.businessName}` : undefined,
      };
      if (r.status === 'pending') {
        const due = new Date(r.dueDate);
        if (due.getTime() > todayEnd.getTime()) continue; // not due yet: not today's work
        tasks.push({ ...common, priority: due.getTime() < ctx.now.getTime() - DAY_MS ? 'high' : 'medium', dueDate: due, sourceStatus: 'pending', state: 'open' });
      } else if (r.status === 'done') {
        tasks.push({
          ...common,
          priority: 'medium',
          sourceStatus: 'done',
          state: 'closed',
          closure: { kind: 'completed', evidence: { type: 'source_status', detail: `Follow-up reminder completed (${String(r.completedVia ?? 'marked done')}).`, at: new Date(r.completedAt ?? r.sentAt ?? r.updatedAt ?? ctx.now), sourceRef: String(r._id) } },
        });
      } else {
        tasks.push({ ...common, priority: 'medium', sourceStatus: 'dismissed', state: 'closed', closure: { kind: 'withdrawn', reason: `Follow-up dismissed${r.dismissedReason ? `: ${String(r.dismissedReason)}` : ''}.` } });
      }
    }

    // ---- customer emails owed a reply ----
    const since = addDays(ctx.now, -ctx.config.emailLookbackDays);
    const items = await this.reader.find(
      'email_intelligence_items',
      { organizationId: ctx.organizationId, ...user, receivedAt: { $gte: since }, threadHead: { $ne: false }, mailboxRemovedAt: { $exists: false } },
      { limit: MAX_SOURCE_ROWS, sort: { receivedAt: -1 } },
    );
    if (items.length >= MAX_SOURCE_ROWS) complete = false;
    for (const item of items) {
      const state = deriveResponseStatus(item);
      const from = String(item.fromName || item.fromAddress || 'a customer');
      const common = {
        sourcePlatform: EMAIL_PLATFORM,
        sourceType: 'email_reply_owed',
        sourceRecordId: String(item._id),
        assignedTo: String(item.userId),
        sourceUrl: EMAIL_URL,
        sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : undefined,
        title: `Reply to ${from}: ${String(item.subject ?? '(no subject)').slice(0, 120)}`,
        description: item.recommendedAction ? String(item.recommendedAction) : undefined,
      };
      if (state === 'needs_response') {
        tasks.push({ ...common, priority: pri(item.urgency === 'urgent' ? 'urgent' : item.priority), dueDate: undefined, sourceStatus: 'needs_response', state: 'open' });
      } else if (state === 'responded') {
        const info = deriveRespondedInfo(item);
        const at = info.respondedAt ? new Date(info.respondedAt) : undefined;
        if (!at || at < closedSince) continue;
        tasks.push({
          ...common,
          priority: 'medium',
          sourceStatus: 'responded',
          state: 'closed',
          closure: { kind: 'completed', evidence: { type: 'source_event', detail: `Reply recorded (${info.respondedVia ?? 'sent'}).`, at, sourceRef: String(item._id) } },
        });
      } else if (item.updatedAt && new Date(item.updatedAt) >= closedSince) {
        tasks.push({ ...common, priority: 'low', sourceStatus: 'resolved', state: 'closed', closure: { kind: 'withdrawn', reason: 'No reply is needed any more (rejected or marked as not needing a reply).' } });
      }
    }

    return { tasks, complete, unresolved: 0 };
  }
}
