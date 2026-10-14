import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EmailSlaService } from '../email-sla/email-sla.service';
import { OutlookConnection, OutlookConnectionDocument } from '../outlook/schemas/outlook-connection.schema';
import { unansweredOwedMatch } from './email-response-state';
import { normalizeAddress, OutboundMessage, replyAwaitsCustomer, ReplyIndex, ReplyMatch } from './email-thread.util';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument } from './schemas/email-intelligence-item.schema';
import { EmailSentItem, EmailSentItemDocument } from './schemas/email-sent-item.schema';

export interface ThreadMessage {
  direction: 'inbound' | 'outbound';
  from: string;
  at: string;
  subject: string;
  preview: string;
}

export interface ReconcileResult {
  /** Messages newly found to have been answered. */
  answered: number;
  /** Conversations whose newest customer message changed. */
  regrouped: number;
}

const REPLY_PREVIEW_LENGTH = 240;
const THREAD_CONTEXT_MESSAGES = 10;
const BULK_CHUNK = 500;

// The response-state engine of the AI Email Inbox: the one place that turns
// what is stored about a mailbox — the mail it received, the mail it sent —
// into the state of each conversation. Deterministic and AI-free.
//
//   reconcile()  for every received message still waiting on a reply, looks for
//                a sent message that answers it (see email-thread.util.ts for
//                what counts) and records the answer on the message; then makes
//                sure each conversation is represented by its newest customer
//                message.
//
// Everything is scoped to one user's mailbox (`userId` is on every query), and
// every write repeats the "still unanswered" condition, so running it twice, or
// from two processes at once, changes nothing the second time.
@Injectable()
export class EmailConversationService {
  private readonly logger = new Logger(EmailConversationService.name);

  constructor(
    @InjectModel(EmailIntelligenceItem.name) private itemModel: Model<EmailIntelligenceItemDocument>,
    @InjectModel(EmailSentItem.name) private sentModel: Model<EmailSentItemDocument>,
    @InjectModel(OutlookConnection.name) private connectionModel: Model<OutlookConnectionDocument>,
    private emailSla: EmailSlaService,
  ) {}

  /** Every address of the user's connected mailbox ("us"), lower-cased. */
  async ownAddresses(userId: string): Promise<string[]> {
    const connections = await this.connectionModel.find({ userId }).select('email addresses').lean().exec();
    const all = connections.flatMap((c) => [c.email, ...(c.addresses ?? [])]).map(normalizeAddress);
    return [...new Set(all.filter(Boolean))];
  }

  /** Remembers the addresses Outlook reports for the mailbox (primary + aliases). */
  async rememberAddresses(userId: string, mailboxEmail: string, addresses: string[] | undefined): Promise<string[]> {
    const known = [...new Set([mailboxEmail, ...(addresses ?? [])].map(normalizeAddress).filter(Boolean))];
    if (addresses?.length) {
      await this.connectionModel.updateOne({ userId, email: mailboxEmail }, { $addToSet: { addresses: { $each: known } } }).exec();
    }
    return known;
  }

  private toOutbound(row: {
    externalMessageId?: string;
    sentAt: Date;
    conversationId?: string;
    internetMessageId?: string;
    inReplyTo?: string;
    references?: string[];
    toAddresses?: string[];
    ccAddresses?: string[];
    subject?: string;
    bodyPreview?: string;
  }): OutboundMessage {
    return {
      id: row.externalMessageId,
      sentAt: row.sentAt,
      conversationId: row.conversationId,
      internetMessageId: row.internetMessageId,
      inReplyTo: row.inReplyTo,
      references: row.references,
      recipients: [...(row.toAddresses ?? []), ...(row.ccAddresses ?? [])],
      subject: row.subject,
      preview: row.bodyPreview,
    };
  }

  /** An index of the mailbox's sent mail from `since` on, for answering "was this replied to?". */
  async replyIndex(userId: string, since: Date, ownAddresses?: string[]): Promise<ReplyIndex> {
    const sent = await this.sentModel
      .find({ userId, sentAt: { $gte: since } })
      .select('externalMessageId sentAt conversationId internetMessageId inReplyTo references toAddresses ccAddresses subject bodyPreview')
      .lean()
      .exec();
    return new ReplyIndex(
      sent.map((row) => this.toOutbound(row)),
      ownAddresses ?? (await this.ownAddresses(userId)),
    );
  }

  /** The fields recorded on a message once a sent message is known to answer it. */
  answeredFields(match: ReplyMatch): Record<string, unknown> {
    return {
      externalReplyDetectedAt: match.at,
      replyMatchedVia: match.via,
      replyMessageId: match.message.id,
      replyPreview: (match.latest.preview ?? '').slice(0, REPLY_PREVIEW_LENGTH) || undefined,
      replyAwaitsCustomer: replyAwaitsCustomer(match.latest.preview),
    };
  }

  /**
   * Brings one mailbox's conversation state in line with its stored mail.
   * Safe to call as often as wanted.
   */
  async reconcile(userId: string): Promise<ReconcileResult> {
    const answered = await this.applyReplies(userId);
    const regrouped = await this.refreshThreadHeads(userId);
    return { answered, regrouped };
  }

  /** Marks every still-unanswered message that a sent message answers. Returns how many. */
  async applyReplies(userId: string): Promise<number> {
    const open = await this.itemModel
      .find({ userId, ...unansweredOwedMatch() })
      .select('_id organizationId conversationId internetMessageId fromAddress subject receivedAt')
      .lean()
      .exec();
    if (open.length === 0) return 0;

    const oldest = open.reduce((min, item) => (item.receivedAt < min ? item.receivedAt : min), open[0].receivedAt);
    // A little before the oldest question: mail servers' clocks differ by seconds.
    const index = await this.replyIndex(userId, new Date(oldest.getTime() - 10 * 60_000));

    const found: { id: Types.ObjectId; organizationId: string; match: ReplyMatch }[] = [];
    for (const item of open) {
      const match = index.findReply({
        receivedAt: item.receivedAt,
        conversationId: item.conversationId,
        internetMessageId: item.internetMessageId,
        fromAddress: item.fromAddress,
        subject: item.subject,
      });
      if (match) found.push({ id: item._id, organizationId: item.organizationId, match });
    }
    if (found.length === 0) return 0;

    let modified = 0;
    for (let i = 0; i < found.length; i += BULK_CHUNK) {
      const result = await this.itemModel.bulkWrite(
        found.slice(i, i + BULK_CHUNK).map(({ id, match }) => ({
          updateOne: {
            // Re-checked at write time: a send or a dismissal that landed in between wins.
            filter: { _id: id, userId, ...unansweredOwedMatch() },
            update: { $set: this.answeredFields(match) },
          },
        })),
        { ordered: false },
      );
      modified += result.modifiedCount ?? 0;
    }
    // An answered email must not go on to breach its response-time target.
    for (const { id, organizationId, match } of found) {
      this.emailSla
        .recordFirstResponse(organizationId, id.toString(), match.at)
        .catch((err) => this.logger.error(`SLA first-response recording failed for ${id.toString()}: ${(err as Error).message}`));
    }
    if (modified > 0) this.logger.log(`Mailbox of user ${userId}: ${modified} message(s) found answered in Outlook`);
    return modified;
  }

  /**
   * Keeps each conversation represented by its newest customer message: that
   * one is the head (and carries how many customer messages the conversation
   * has); the older ones are marked as not the head. Mail from our own
   * organization is never part of this — it is not a customer asking.
   * `conversationIds` limits the work to conversations that just changed.
   */
  async refreshThreadHeads(userId: string, conversationIds?: string[]): Promise<number> {
    const ids = conversationIds ? [...new Set(conversationIds.filter(Boolean))] : undefined;
    if (ids && ids.length === 0) return 0;
    const threads = await this.itemModel
      .aggregate<{ _id: string; head: Types.ObjectId; count: number; stale: number }>([
        { $match: { userId, conversationId: ids ? { $in: ids } : { $exists: true, $nin: [null, ''] }, fromRole: { $ne: 'internal' } } },
        { $sort: { receivedAt: -1, _id: -1 } },
        {
          $group: {
            _id: '$conversationId',
            head: { $first: '$_id' },
            headFlag: { $first: '$threadHead' },
            headCount: { $first: '$threadMessageCount' },
            count: { $sum: 1 },
            // Older messages still presenting themselves as the head.
            wrongHeads: { $sum: { $cond: [{ $ne: ['$threadHead', false] }, 1, 0] } },
          },
        },
        // Only conversations whose stored grouping is out of date.
        {
          $match: {
            $or: [
              { count: { $gt: 1 }, wrongHeads: { $ne: 1 } },
              { count: { $gt: 1 }, headFlag: false },
              { count: { $gt: 1 }, $expr: { $ne: ['$headCount', '$count'] } },
              { count: 1, headFlag: false },
            ],
          },
        },
        { $project: { head: 1, count: 1 } },
      ])
      .allowDiskUse(true)
      .exec();
    if (threads.length === 0) return 0;

    for (let i = 0; i < threads.length; i += BULK_CHUNK) {
      await this.itemModel.bulkWrite(
        threads.slice(i, i + BULK_CHUNK).flatMap((thread) => [
          {
            updateMany: {
              filter: { userId, conversationId: thread._id, _id: { $ne: thread.head }, fromRole: { $ne: 'internal' }, threadHead: { $ne: false } },
              update: { $set: { threadHead: false } },
            },
          },
          { updateOne: { filter: { _id: thread.head, userId }, update: { $set: { threadHead: true, threadMessageCount: thread.count } } } },
        ]),
        { ordered: false },
      );
    }
    return threads.length;
  }

  /**
   * The conversation so far, oldest first — what the customer wrote and what
   * we wrote back — for the AI to read before it judges the newest message.
   * Stored previews only; nothing is fetched from Outlook.
   */
  async threadContext(userId: string, conversationId: string | undefined, before: Date, excludeItemId?: string): Promise<ThreadMessage[]> {
    if (!conversationId) return [];
    const [inbound, outbound] = await Promise.all([
      this.itemModel
        .find({ userId, conversationId, receivedAt: { $lte: before }, ...(excludeItemId ? { _id: { $ne: excludeItemId } } : {}) })
        .sort({ receivedAt: -1 })
        .limit(THREAD_CONTEXT_MESSAGES)
        .select('fromAddress receivedAt subject bodyPreview')
        .lean()
        .exec(),
      this.sentModel
        .find({ userId, conversationId, sentAt: { $lte: before } })
        .sort({ sentAt: -1 })
        .limit(THREAD_CONTEXT_MESSAGES)
        .select('fromAddress mailboxEmail sentAt subject bodyPreview')
        .lean()
        .exec(),
    ]);
    const messages = [
      ...inbound.map((m) => ({ direction: 'inbound' as const, from: m.fromAddress, at: m.receivedAt, subject: m.subject, preview: m.bodyPreview })),
      ...outbound.map((m) => ({
        direction: 'outbound' as const,
        from: m.fromAddress || m.mailboxEmail,
        at: m.sentAt,
        subject: m.subject,
        preview: m.bodyPreview,
      })),
    ];
    return messages
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(-THREAD_CONTEXT_MESSAGES)
      .map((m) => ({ ...m, at: m.at.toISOString() }));
  }

  /** Both sides of one conversation, oldest first, for the detail view's timeline. */
  async sentInConversation(userId: string, conversationId: string | undefined, limit = 100) {
    if (!conversationId) return [];
    return this.sentModel.find({ userId, conversationId }).sort({ sentAt: 1 }).limit(limit).select('subject toAddresses sentAt bodyPreview').lean().exec();
  }
}
