import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { deriveResponseStatus, ResponseStateFields } from '../email-intelligence/email-response-state';
import { EmailRecord, FollowUpRecord } from './customer-timeline';

/** The mail exchanged with one address, counted. */
export interface EmailSummary {
  received: number;
  sent: number;
  /** Emails from the customer nobody has answered. */
  unanswered: number;
  lastReceivedAt?: Date;
  lastSentAt?: Date;
  oldestUnansweredAt?: Date;
  /** When each of those emails was received or sent (epoch ms) — for asking "was anything exchanged in this period?". */
  activityAt: number[];
  /** Follow-up reminders set on their emails that are still to do. */
  followUps: { title: string; dueDate: Date }[];
}

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
const lower = (value: unknown): string => text(value).toLowerCase();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
};

const MAX_EMAILS = 300;
const MAX_REMINDERS = 2000;

// The mail exchanged with customers, read from HaiVE's own mailbox collections
// (filled by the Outlook sync) by email address — the one identifier a CRM
// record and a mailbox share. Counted for a whole table of customers at once,
// or loaded message by message for one customer's timeline.
//
// Everything is read with the caller's organizationId.
@Injectable()
export class CustomerMailService {
  constructor(@InjectConnection() private connection: Connection) {}

  /**
   * For each address: how many emails came from it and went to it, how many of
   * theirs nobody has answered, and when each side last wrote. One pass over
   * the mailbox for the whole list — what a table of customers needs.
   */
  async emailSummaries(organizationId: string, addresses: string[]): Promise<Map<string, EmailSummary>> {
    const wanted = [...new Set(addresses.map(lower).filter(Boolean))];
    const byAddress = new Map<string, EmailSummary>();
    if (wanted.length === 0) return byAddress;
    const summaryFor = (key: string) => {
      let summary = byAddress.get(key);
      if (!summary) byAddress.set(key, (summary = { received: 0, sent: 0, unanswered: 0, activityAt: [], followUps: [] }));
      return summary;
    };
    const [received, sent, reminders] = await Promise.all([
      this.connection
        .collection('email_intelligence_items')
        .find(
          // Addresses are compared case-insensitively (mail clients keep whatever case was typed).
          { organizationId, $expr: { $in: [{ $toLower: '$fromAddress' }, wanted] } },
          {
            projection: {
              fromAddress: 1,
              receivedAt: 1,
              status: 1,
              shouldDraft: 1,
              expectedNextAction: 1,
              aiStatus: 1,
              sentAt: 1,
              externalReplyDetectedAt: 1,
              threadRespondedAt: 1,
              threadHead: 1,
              mailboxRemovedAt: 1,
            },
          },
        )
        .toArray(),
      this.connection
        .collection('email_sent_items')
        .aggregate<{ _id: string; count: number; last: Date; dates: unknown[] }>([
          { $match: { organizationId } },
          { $unwind: '$toAddresses' },
          { $project: { to: { $toLower: '$toAddresses' }, sentAt: 1 } },
          { $match: { to: { $in: wanted } } },
          { $group: { _id: '$to', count: { $sum: 1 }, last: { $max: '$sentAt' }, dates: { $push: '$sentAt' } } },
        ])
        .toArray(),
      // The follow-ups still to do, whoever in the organization set them: there are few, and each names its email.
      this.connection
        .collection('email_follow_up_reminders')
        .find({ organizationId, status: 'pending' }, { projection: { emailIntelligenceItemId: 1, title: 1, dueDate: 1 } })
        .limit(MAX_REMINDERS)
        .toArray(),
    ]);
    const senderOf = new Map(received.map((item) => [item._id.toString(), lower(item.fromAddress)]));
    for (const reminder of reminders) {
      const address = senderOf.get(text(reminder.emailIntelligenceItemId));
      const dueDate = asDate(reminder.dueDate);
      if (address && dueDate) summaryFor(address).followUps.push({ title: text(reminder.title) || 'Follow-up', dueDate });
    }
    for (const item of received) {
      const summary = summaryFor(lower(item.fromAddress));
      summary.received += 1;
      const at = asDate(item.receivedAt);
      if (deriveResponseStatus(item as ResponseStateFields) === 'needs_response') {
        summary.unanswered += 1;
        if (at && (!summary.oldestUnansweredAt || at < summary.oldestUnansweredAt)) summary.oldestUnansweredAt = at;
      }
      if (at && (!summary.lastReceivedAt || at > summary.lastReceivedAt)) summary.lastReceivedAt = at;
      if (at) summary.activityAt.push(at.getTime());
      // A reply sent through HaiVE itself is a sent email too.
      const viaApp = asDate(item.sentAt);
      if (viaApp && (!summary.lastSentAt || viaApp > summary.lastSentAt)) summary.lastSentAt = viaApp;
      if (viaApp) summary.activityAt.push(viaApp.getTime());
    }
    for (const row of sent) {
      const summary = summaryFor(row._id);
      summary.sent = row.count;
      const last = asDate(row.last);
      if (last && (!summary.lastSentAt || last > summary.lastSentAt)) summary.lastSentAt = last;
      for (const date of row.dates ?? []) {
        const sentAt = asDate(date);
        if (sentAt) summary.activityAt.push(sentAt.getTime());
      }
    }
    return byAddress;
  }

  /** Every email exchanged with these addresses (the customer may have more than one), and the follow-ups set on them. */
  async loadEmails(organizationId: string, addresses: string[]): Promise<{ emails: EmailRecord[]; followUps: FollowUpRecord[] }> {
    const wanted = [...new Set(addresses.map(lower).filter(Boolean))];
    if (wanted.length === 0) return { emails: [], followUps: [] };
    const [receivedDocs, sentDocs] = await Promise.all([
      this.connection
        .collection('email_intelligence_items')
        .find({ organizationId, $expr: { $in: [{ $toLower: '$fromAddress' }, wanted] } })
        .sort({ receivedAt: -1 })
        .limit(MAX_EMAILS)
        .toArray(),
      this.connection
        .collection('email_sent_items')
        .find({ organizationId, toAddresses: { $in: wanted.map((address) => new RegExp(`^${escapeRegExp(address)}$`, 'i')) } })
        .sort({ sentAt: -1 })
        .limit(MAX_EMAILS)
        .toArray(),
    ]);
    const reminderDocs = receivedDocs.length
      ? await this.connection
          .collection('email_follow_up_reminders')
          .find({ organizationId, emailIntelligenceItemId: { $in: receivedDocs.map((m) => m._id.toString()) } })
          .limit(200)
          .toArray()
      : [];

    // The same message stored under two mailboxes (two colleagues on one thread) is one email.
    const emails: EmailRecord[] = [];
    const seen = new Set<string>();
    const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
    for (const m of receivedDocs) {
      const at = asDate(m.receivedAt);
      if (!at || !once(`in|${text(m.internetMessageId) || m._id.toString()}`)) continue;
      const state = deriveResponseStatus(m as ResponseStateFields);
      emails.push({
        id: m._id.toString(),
        direction: 'received',
        at,
        subject: text(m.subject) || '(no subject)',
        conversationId: text(m.conversationId) || undefined,
        needsReply: state === 'needs_response',
        answeredAt: asDate(m.sentAt) ?? asDate(m.externalReplyDetectedAt) ?? asDate(m.threadRespondedAt),
      });
    }
    for (const m of sentDocs) {
      const at = asDate(m.sentAt);
      if (!at || !once(`out|${text(m.internetMessageId) || m._id.toString()}`)) continue;
      emails.push({
        id: m._id.toString(),
        direction: 'sent',
        at,
        subject: text(m.subject) || '(no subject)',
        conversationId: text(m.conversationId) || undefined,
      });
    }

    const followUps: FollowUpRecord[] = reminderDocs
      .map((r) => ({
        title: text(r.title) || 'Follow-up',
        dueDate: asDate(r.dueDate),
        status: (['pending', 'done', 'dismissed'].includes(text(r.status)) ? text(r.status) : 'pending') as FollowUpRecord['status'],
      }))
      .filter((r): r is FollowUpRecord => !!r.dueDate);
    return { emails, followUps };
  }
}
