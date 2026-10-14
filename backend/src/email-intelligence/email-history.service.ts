import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { AxiosError } from 'axios';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { CustomerActivityService, TodaysEmail } from '../crm/customer-activity.service';
import { correlateSingleEmail } from '../crm/customer-grouping.util';
import { OutlookConnection, OutlookConnectionDocument } from '../outlook/schemas/outlook-connection.schema';
import { UsersService } from '../users/users.service';
import { EmailConversationService } from './email-conversation.service';
import { EmailIntelligenceService } from './email-intelligence.service';
import { classifyEmailDeterministically } from './email-preclassification.util';
import { needsResponseMatch } from './email-response-state';
import { PUBLIC_MAIL_DOMAINS } from './email-thread.util';
import { EmailFollowUpReminder, EmailFollowUpReminderDocument } from './schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument } from './schemas/email-intelligence-item.schema';
import { EmailSentItem, EmailSentItemDocument } from './schemas/email-sent-item.schema';

export interface SentMessage {
  from?: string;
  cc?: string[];
  internetMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  id: string;
  conversationId: string;
  sentAt: string;
  subject?: string;
  to?: string[];
  preview?: string;
}

export interface HistoryImportResult {
  connected: boolean;
  days: number;
  inboxScanned: number;
  inboxAdded: number;
  sentScanned: number;
  sentAdded: number;
  markedResponded: number;
  // The window held more mail than one import reads; import a shorter range to get the rest.
  truncated: boolean;
}

export type FollowUpBucket = 'not_responded' | 'follow_up_required' | 'overdue_follow_up';

export interface FollowUpRow {
  id: string;
  bucket: FollowUpBucket;
  kind: 'unanswered' | 'promised_follow_up' | 'awaiting_customer' | 'reminder';
  emailId: string;
  reminderId?: string;
  customer: string;
  company?: string;
  subject: string;
  lastCustomerMessage?: { preview: string; at: Date };
  lastResponseAt?: Date;
  daysWaiting: number;
  reason: string;
  suggestedAction: string;
  // A reply/follow-up already drafted for this (by the AI, awaiting review).
  suggestedMessage?: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORT_DAYS = 730;
const INSERT_CHUNK = 500;
// A customer email is overdue once it has waited this long (the same 24h the dashboards call "missed").
const OVERDUE_HOURS = 24;
// After we reply, a nudge is worth considering once the customer has been silent this long…
const NUDGE_DAYS = 3;
// …and is overdue after this long. A promised follow-up is due sooner.
const NUDGE_OVERDUE_DAYS = 7;
const PROMISE_DUE_DAYS = 2;
const FOLLOW_UP_LOOKBACK_DAYS = 60;

// Senders nobody is expected to answer.
const NO_REPLY_SENDER = /^(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|mailer|newsletter|news|updates?|bounces?|billing-noreply)[^@]*@/i;
// "I'll get back to you", "we will send the quote", "will revert by Monday"…
const PROMISE_PATTERN =
  /\b(?:i|we)(?:'ll|’ll| will| shall)\s+(?:get back|revert|come back|follow up|send|share|update|confirm|check|call|email|let you know|arrange|forward)\b[^.!?\n]{0,120}|\b(?:will|shall)\s+(?:get back|revert)\b[^.!?\n]{0,120}/i;

const domainOf = (address: string) => address.trim().toLowerCase().split('@')[1] ?? '';

// Mailbox history and follow-up analysis for the AI Email Inbox.
//
// History: the regular sync only looks back a couple of weeks and has every
// new message read by the AI. This service imports OLDER mail — inbox and
// sent, as far back as Outlook has it, page by page — without an AI call per
// message: who an email is from, whether anyone is expected to answer it, and
// whether it was answered are all decided from the message and the Sent Items
// of the same conversation. A person can still run the AI on any one of them.
//
// Follow-ups: what still needs doing is read from the threads themselves —
// a customer message with no reply after it, our own "I'll get back to you"
// with nothing sent since, a reply the customer never answered — not from
// whether a message is marked read.
@Injectable()
export class EmailHistoryService {
  private readonly logger = new Logger(EmailHistoryService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(EmailIntelligenceItem.name) private itemModel: Model<EmailIntelligenceItemDocument>,
    @InjectModel(EmailSentItem.name) private sentModel: Model<EmailSentItemDocument>,
    @InjectModel(EmailFollowUpReminder.name) private reminderModel: Model<EmailFollowUpReminderDocument>,
    @InjectModel(OutlookConnection.name) private connectionModel: Model<OutlookConnectionDocument>,
    private emailIntelligence: EmailIntelligenceService,
    private conversations: EmailConversationService,
    private customerActivity: CustomerActivityService,
    private users: UsersService,
    private http: HttpService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    this.pythonAgentUrl = config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  // ---- sent mail ---------------------------------------------------------------

  /** Stores Sent Items messages (idempotent). Returns how many were new. */
  async storeSent(organizationId: string, userId: string, mailboxEmail: string, messages: SentMessage[]): Promise<number> {
    const valid = messages.filter((m) => m.id && m.sentAt && !Number.isNaN(new Date(m.sentAt).getTime()));
    let added = 0;
    for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
      const result = await this.sentModel.bulkWrite(
        valid.slice(i, i + INSERT_CHUNK).map((m) => ({
          updateOne: {
            filter: { userId, externalMessageId: m.id },
            update: {
              $setOnInsert: {
                organizationId,
                userId,
                mailboxEmail,
                externalMessageId: m.id,
                conversationId: m.conversationId || undefined,
                sentAt: new Date(m.sentAt),
                subject: m.subject ?? '',
                toAddresses: (m.to ?? []).filter(Boolean),
                bodyPreview: m.preview ?? '',
              },
              // Threading details — also filled in on rows stored before they were captured.
              $set: {
                ...(m.from ? { fromAddress: m.from } : {}),
                ...(m.cc?.length ? { ccAddresses: m.cc.filter(Boolean) } : {}),
                ...(m.internetMessageId ? { internetMessageId: m.internetMessageId } : {}),
                ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
                ...(m.references?.length ? { references: m.references } : {}),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      added += result.upsertedCount ?? 0;
    }
    return added;
  }

  async listSent(userId: string, query: { search?: string; from?: string; to?: string; skip?: number; limit?: number }) {
    const match: Record<string, unknown> = { userId };
    if (query.from || query.to) {
      match.sentAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(`${query.to.slice(0, 10)}T23:59:59.999Z`) } : {}),
      };
    }
    const search = query.search?.trim().slice(0, 100);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ subject: rx }, { toAddresses: rx }, { bodyPreview: rx }];
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const [items, total] = await Promise.all([
      this.sentModel
        .find(match)
        .sort({ sentAt: -1, _id: -1 })
        .skip(Math.max(query.skip ?? 0, 0))
        .limit(limit)
        .select('subject toAddresses sentAt bodyPreview conversationId')
        .lean()
        .exec(),
      this.sentModel.countDocuments(match).exec(),
    ]);
    return { total, items: items.map((s) => ({ id: s._id.toString(), subject: s.subject, to: s.toAddresses, sentAt: s.sentAt, preview: s.bodyPreview })) };
  }

  /** How much of this mailbox HaiVE holds, so the page can say how far back it goes. */
  async status(userId: string) {
    const [inboxCount, sentCount, oldestInbox, oldestSent] = await Promise.all([
      this.itemModel.countDocuments({ userId }).exec(),
      this.sentModel.countDocuments({ userId }).exec(),
      this.itemModel.findOne({ userId }).sort({ receivedAt: 1 }).select('receivedAt').lean().exec(),
      this.sentModel.findOne({ userId }).sort({ sentAt: 1 }).select('sentAt').lean().exec(),
    ]);
    return { inboxCount, sentCount, oldestInboxAt: oldestInbox?.receivedAt ?? null, oldestSentAt: oldestSent?.sentAt ?? null, maxDays: MAX_IMPORT_DAYS };
  }

  // ---- history import ------------------------------------------------------------

  private async fetchHistory<T>(
    userId: string,
    folder: 'inbox' | 'sent',
    since: string,
  ): Promise<{ connected: boolean; messages: T[]; truncated: boolean; mailboxAddresses?: string[] }> {
    const token = this.jwt.sign({ sub: userId }, { expiresIn: '10m' });
    try {
      const { data } = await firstValueFrom(
        this.http.get<{ connected: boolean; messages: T[]; truncated: boolean; mailboxAddresses?: string[] }>(`${this.pythonAgentUrl}/outlook/history`, {
          params: { folder, since },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 300_000,
        }),
      );
      return data;
    } catch (err) {
      const response = (err as AxiosError<{ detail?: unknown }>).response;
      const detail = response?.data?.detail;
      if (response && typeof detail === 'string' && [401, 403, 502].includes(response.status)) throw new BadRequestException(detail);
      this.logger.error(`Mailbox history fetch (${folder}) failed for user ${userId}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The mailbox history couldn’t be read right now. Please try again in a minute.');
    }
  }

  /** An inbox message stored without an AI call — see the class comment. */
  private historyItem(
    organizationId: string,
    userId: string,
    mailboxEmail: string,
    email: TodaysEmail,
    correlation: ReturnType<typeof correlateSingleEmail>,
    ownAddresses: string[] = [],
  ): Record<string, unknown> {
    const from = email.from.trim().toLowerCase();
    const mailbox = mailboxEmail.trim().toLowerCase();
    // "Us" is every address of the mailbox and every (non-public) domain they are on.
    const own = new Set([mailbox, ...ownAddresses.map((a) => a.trim().toLowerCase())]);
    const ownDomains = new Set([...own].map(domainOf).filter((d) => d && !PUBLIC_MAIL_DOMAINS.has(d)));
    const automated = classifyEmailDeterministically({ from: email.from, subject: email.subject ?? '', preview: email.preview ?? '' });
    const internal = own.has(from) || ownDomains.has(domainOf(from));
    const noReply = NO_REPLY_SENDER.test(from);

    let verdict: { fromRole: string; expectedNextAction: string; aiStatus?: string; reason: string; intent: string; priority: string };
    if (internal) {
      verdict = {
        fromRole: 'internal',
        expectedNextAction: 'no_action_required',
        aiStatus: 'no_reply_needed',
        intent: 'internal',
        priority: 'low',
        reason: 'From your own organization — not tracked as a customer reply.',
      };
    } else if (automated || noReply) {
      verdict = {
        fromRole: 'external_other',
        expectedNextAction: 'no_action_required',
        aiStatus: 'no_reply_needed',
        intent: 'other',
        priority: 'low',
        reason: automated?.reason ?? 'Sent from a no-reply address — no reply expected.',
      };
    } else {
      verdict = {
        fromRole: correlation ? 'customer' : 'external_other',
        // A reply is owed until Sent Items shows one after it (markExternalReplies).
        expectedNextAction: 'company_reply',
        intent: correlation ? 'existing_customer' : 'other',
        priority: 'medium',
        reason: 'Imported from mailbox history — not read by the AI. Run AI analysis for a suggested reply.',
      };
    }
    return {
      organizationId,
      userId,
      mailboxEmail,
      externalMessageId: email.id,
      conversationId: email.conversationId || undefined,
      ...(email.internetMessageId ? { internetMessageId: email.internetMessageId } : {}),
      ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
      ...(email.references?.length ? { references: email.references } : {}),
      ...(email.fromName ? { fromName: email.fromName } : {}),
      ...(email.cc?.length ? { ccAddresses: email.cc } : {}),
      receivedAt: new Date(email.receivedAt),
      subject: email.subject ?? '',
      fromAddress: email.from,
      toAddresses: email.to ?? [],
      bodyPreview: email.preview ?? '',
      isRead: email.isRead,
      importance: email.importance ?? 'normal',
      matchConfidence: correlation?.matchConfidence ?? 'none',
      matchedBusinessKey: correlation?.matchedBusinessKey,
      matchedBusinessName: correlation?.matchedBusinessName,
      resolvedGroupKey: correlation?.resolvedGroupKey ?? undefined,
      intent: verdict.intent,
      priority: verdict.priority,
      urgency: verdict.priority,
      sentiment: 'neutral',
      recommendedAction: verdict.reason,
      shouldDraft: false,
      fromRole: verdict.fromRole,
      expectedNextAction: verdict.expectedNextAction,
      aiStatus: verdict.aiStatus,
      reason: verdict.reason,
      status: 'pending',
      wasEdited: false,
      regeneratedCount: 0,
      deterministicInput: { skippedLlmCall: true, reasonForSkip: 'history import' },
      result: {},
    };
  }

  /**
   * Brings in up to `days` of older inbox and sent mail for the caller's
   * connected mailbox. Safe to repeat: messages already stored are skipped.
   * No AI calls, no notifications, no SLA timers — this is the past.
   */
  async importHistory(userId: string, days: number): Promise<HistoryImportResult> {
    if (!Number.isFinite(days) || days < 1) throw new BadRequestException('Choose how many days of history to load.');
    const window = Math.min(Math.round(days), MAX_IMPORT_DAYS);
    const user = await this.users.findById(userId);
    const connection = await this.connectionModel.findOne({ userId, isActive: true }).exec();
    const empty = { connected: false, days: window, inboxScanned: 0, inboxAdded: 0, sentScanned: 0, sentAdded: 0, markedResponded: 0, truncated: false };
    if (!user || !connection) return empty;

    const since = new Date(Date.now() - window * DAY_MS).toISOString();
    const [inbox, sent] = await Promise.all([this.fetchHistory<TodaysEmail>(userId, 'inbox', since), this.fetchHistory<SentMessage>(userId, 'sent', since)]);
    if (!inbox.connected || !sent.connected) return empty;

    // Inbox: only what isn't stored yet.
    const known = new Set<string>();
    const ids = inbox.messages.map((m) => m.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.itemModel
        .find({ userId, externalMessageId: { $in: ids.slice(i, i + 1000) } })
        .select('externalMessageId')
        .lean()
        .exec();
      for (const row of rows) known.add(row.externalMessageId);
    }
    const ownAddresses = await this.conversations.rememberAddresses(userId, connection.email, inbox.mailboxAddresses ?? sent.mailboxAddresses);
    // A message Outlook re-issued an id for (moved between folders) is already stored under its Message-ID.
    const knownMessageIds = new Set<string>();
    const messageIds = inbox.messages.map((m) => m.internetMessageId).filter((id): id is string => !!id);
    for (let i = 0; i < messageIds.length; i += 1000) {
      const rows = await this.itemModel
        .find({ userId, internetMessageId: { $in: messageIds.slice(i, i + 1000) } })
        .select('internetMessageId')
        .lean()
        .exec();
      for (const row of rows) if (row.internetMessageId) knownMessageIds.add(row.internetMessageId);
    }
    const seen = new Set<string>();
    const fresh = inbox.messages.filter((m) => {
      if (!m.id || !m.receivedAt || known.has(m.id)) return false;
      if (!m.internetMessageId) return true;
      if (knownMessageIds.has(m.internetMessageId) || seen.has(m.internetMessageId)) return false;
      seen.add(m.internetMessageId);
      return true;
    });
    let inboxAdded = 0;
    if (fresh.length > 0) {
      const context = await this.customerActivity.gatherCorrelationContext(user.organizationId);
      const docs = fresh.map((email) =>
        this.historyItem(
          user.organizationId,
          userId,
          connection.email,
          email,
          correlateSingleEmail({ from: email.from, to: email.to ?? [], subject: email.subject ?? '' }, context),
          ownAddresses,
        ),
      );
      for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
        try {
          // Raw inserts: no per-document hooks, and a duplicate (a sync running
          // at the same moment) only skips that one message.
          const result = await this.itemModel.collection.insertMany(
            docs.slice(i, i + INSERT_CHUNK).map((d) => ({ ...d, createdAt: new Date(), updatedAt: new Date() })),
            { ordered: false },
          );
          inboxAdded += result.insertedCount;
        } catch (err) {
          const partial = (err as { result?: { insertedCount?: number }; insertedCount?: number }) ?? {};
          inboxAdded += partial.result?.insertedCount ?? partial.insertedCount ?? 0;
          if ((err as { code?: number }).code !== 11000) this.logger.error(`History insert failed for user ${userId}: ${(err as Error).message}`);
        }
      }
    }

    const sentAdded = await this.storeSent(user.organizationId, userId, connection.email, sent.messages);
    const markedResponded = await this.applyReplies(userId);
    await this.conversations.refreshThreadHeads(userId);
    await this.maintainFollowUps(userId).catch((err) => this.logger.error(`Follow-up maintenance failed for user ${userId}: ${(err as Error).message}`));

    this.logger.log(
      `History import for user ${userId}: ${inboxAdded}/${inbox.messages.length} inbox, ${sentAdded}/${sent.messages.length} sent, ${markedResponded} answered`,
    );
    return {
      connected: true,
      days: window,
      inboxScanned: inbox.messages.length,
      inboxAdded,
      sentScanned: sent.messages.length,
      sentAdded,
      markedResponded,
      truncated: inbox.truncated || sent.truncated,
    };
  }

  /** Marks every still-open message that a stored sent message answers (see EmailConversationService). */
  async applyReplies(userId: string): Promise<number> {
    return this.conversations.applyReplies(userId);
  }

  // ---- follow-ups ------------------------------------------------------------------

  /**
   * Keeps follow-up reminders in step with the mailbox:
   *  - our own "I'll get back to you / will send…" with nothing sent in that
   *    conversation since becomes a "promised follow-up" reminder;
   *  - a reminder whose promise was kept (we sent something later), or whose
   *    customer has since written back, is closed.
   * Runs after every sync and history import. No AI involved.
   */
  async maintainFollowUps(userId: string): Promise<void> {
    const since = new Date(Date.now() - FOLLOW_UP_LOOKBACK_DAYS * DAY_MS);
    const sent = await this.sentModel
      .find({ userId, sentAt: { $gte: since }, conversationId: { $exists: true, $ne: '' } })
      .sort({ sentAt: 1 })
      .select('conversationId sentAt bodyPreview subject organizationId')
      .lean()
      .exec();
    const byConversation = new Map<string, typeof sent>();
    for (const message of sent) byConversation.set(message.conversationId!, [...(byConversation.get(message.conversationId!) ?? []), message]);

    for (const [conversationId, messages] of byConversation) {
      const last = messages[messages.length - 1];
      const promise = PROMISE_PATTERN.exec(last.bodyPreview ?? '');
      // Only the latest thing we sent can be an unkept promise — anything sent after it kept it.
      if (!promise) continue;
      const inbound = await this.itemModel.find({ userId, conversationId }).sort({ receivedAt: -1 }).limit(1).exec();
      const anchor = inbound[0];
      // No customer message on record, or the customer already wrote back (that's a new question, tracked on its own).
      if (!anchor || anchor.receivedAt > last.sentAt || anchor.fromRole === 'internal') continue;
      await this.reminderModel
        .updateOne(
          { organizationId: anchor.organizationId, emailIntelligenceItemId: anchor._id.toString(), reminderType: 'promised_follow_up' },
          {
            $setOnInsert: {
              organizationId: anchor.organizationId,
              userId,
              emailIntelligenceItemId: anchor._id.toString(),
              reminderType: 'promised_follow_up',
              businessName: anchor.matchedBusinessName,
              title: `Promised follow-up: ${anchor.subject || last.subject || '(no subject)'}`,
              dueDate: new Date(last.sentAt.getTime() + PROMISE_DUE_DAYS * DAY_MS),
              status: 'pending',
              draftStatus: 'none',
              promisedAt: last.sentAt,
              promiseExcerpt: promise[0].trim().slice(0, 200),
            },
          },
          { upsert: true },
        )
        .exec();
    }

    // Close reminders the mailbox shows are no longer needed.
    const pending = await this.reminderModel.find({ userId, status: 'pending', reminderType: { $in: ['promised_follow_up', 'post_reply'] } }).exec();
    for (const reminder of pending) {
      const item = await this.itemModel.findOne({ _id: reminder.emailIntelligenceItemId, userId }).select('conversationId').lean().exec();
      if (!item?.conversationId) continue;
      const after = reminder.promisedAt ?? reminder.createdAt;
      const [keptPromise, customerReplied] = await Promise.all([
        reminder.reminderType === 'promised_follow_up' ? this.sentModel.exists({ userId, conversationId: item.conversationId, sentAt: { $gt: after } }) : null,
        this.itemModel.exists({ userId, conversationId: item.conversationId, receivedAt: { $gt: after }, fromRole: { $ne: 'internal' } }),
      ]);
      if (keptPromise || customerReplied) {
        reminder.status = 'done';
        reminder.dismissedReason = keptPromise ? 'A later message was sent in this conversation.' : 'The customer has replied since.';
        await reminder.save();
      }
    }
  }

  /**
   * Who is waiting on whom, from the threads themselves. Three lists (the
   * fourth state, Responded, is a count): customer emails nobody has answered,
   * follow-ups that are due, and follow-ups that are overdue.
   */
  async followUpAnalysis(userId: string): Promise<{ counts: Record<FollowUpBucket | 'responded', number>; rows: FollowUpRow[] }> {
    const now = Date.now();
    const days = (from: Date) => Math.max(0, Math.floor((now - from.getTime()) / DAY_MS));
    const rows: FollowUpRow[] = [];
    const customerOf = (item: { matchedBusinessName?: string; fromAddress: string }) => ({
      customer: item.fromAddress,
      company: item.matchedBusinessName || undefined,
    });

    // 1. Customer emails nobody has answered.
    const unanswered = await this.itemModel
      .find({ userId, ...needsResponseMatch() })
      .sort({ receivedAt: 1 })
      .limit(300)
      .exec();
    const lastSentByConversation = new Map<string, Date>();
    const conversations = [...new Set(unanswered.map((u) => u.conversationId).filter((c): c is string => !!c))];
    if (conversations.length > 0) {
      const sentRows = await this.sentModel
        .aggregate<{ _id: string; at: Date }>([
          { $match: { userId, conversationId: { $in: conversations } } },
          { $group: { _id: '$conversationId', at: { $max: '$sentAt' } } },
        ])
        .exec();
      for (const row of sentRows) lastSentByConversation.set(row._id, row.at);
    }
    for (const item of unanswered) {
      const waitedHours = (now - item.receivedAt.getTime()) / 3_600_000;
      const waited = days(item.receivedAt);
      const overdue = waitedHours > OVERDUE_HOURS;
      rows.push({
        id: `email-${item._id.toString()}`,
        bucket: 'not_responded',
        kind: 'unanswered',
        emailId: item._id.toString(),
        ...customerOf(item),
        subject: item.subject || '(no subject)',
        lastCustomerMessage: { preview: item.bodyPreview, at: item.receivedAt },
        lastResponseAt: item.conversationId ? lastSentByConversation.get(item.conversationId) : undefined,
        daysWaiting: waited,
        reason: overdue
          ? `The customer wrote ${waited >= 1 ? `${waited} day${waited === 1 ? '' : 's'}` : `${Math.floor(waitedHours)} hours`} ago and no reply has been sent in this conversation.`
          : 'A customer email that hasn’t been answered yet.',
        suggestedAction: item.draftReply ? 'Review the drafted reply and send it.' : 'Reply to the customer — run AI analysis for a suggested reply.',
        suggestedMessage: item.finalDraftReply ?? item.draftReply ?? undefined,
        priority:
          waited >= 3 || item.priority === 'urgent' ? 'urgent' : overdue || item.priority === 'high' ? 'high' : (item.priority as FollowUpRow['priority']),
      });
    }

    // 2. Follow-up reminders: promised follow-ups, replies awaiting the customer, SLA follow-ups.
    const reminders = await this.reminderModel.find({ userId, status: 'pending' }).sort({ dueDate: 1 }).limit(300).exec();
    const reminderItems = await this.itemModel.find({ _id: { $in: reminders.map((r) => r.emailIntelligenceItemId) }, userId }).exec();
    const itemById = new Map(reminderItems.map((i) => [i._id.toString(), i]));
    for (const reminder of reminders) {
      const item = itemById.get(reminder.emailIntelligenceItemId);
      if (!item) continue;
      const responded = reminder.promisedAt ?? item.sentAt ?? item.externalReplyDetectedAt ?? item.threadRespondedAt ?? reminder.createdAt;
      const waited = days(responded);
      const promised = reminder.reminderType === 'promised_follow_up';
      const overdue = reminder.dueDate.getTime() < now && (promised || waited >= NUDGE_OVERDUE_DAYS || reminder.reminderType === 'sla_breach');
      rows.push({
        id: `reminder-${reminder._id.toString()}`,
        bucket: overdue ? 'overdue_follow_up' : 'follow_up_required',
        kind: promised ? 'promised_follow_up' : reminder.reminderType === 'post_reply' ? 'awaiting_customer' : 'reminder',
        emailId: item._id.toString(),
        reminderId: reminder._id.toString(),
        ...customerOf(item),
        company: reminder.businessName || item.matchedBusinessName || undefined,
        subject: item.subject || '(no subject)',
        lastCustomerMessage: { preview: item.bodyPreview, at: item.receivedAt },
        lastResponseAt: responded,
        daysWaiting: waited,
        reason: promised
          ? `You wrote “${reminder.promiseExcerpt ?? 'you would follow up'}” ${waited} day${waited === 1 ? '' : 's'} ago and nothing has been sent in this conversation since.`
          : reminder.reminderType === 'sla_breach'
            ? 'This email went past its response-time target.'
            : `You replied ${waited} day${waited === 1 ? '' : 's'} ago and the customer hasn’t written back.`,
        suggestedAction: promised
          ? 'Send what you promised, or let the customer know when to expect it.'
          : 'Send a short follow-up to keep the conversation moving.',
        suggestedMessage: reminder.draftReply ?? undefined,
        priority: overdue ? 'high' : 'medium',
      });
    }

    // 3. Replies sent straight from Outlook that the customer never answered (no reminder exists for those).
    const reminded = new Set(reminders.map((r) => r.emailIntelligenceItemId));
    const answeredInOutlook = await this.itemModel
      .find({
        userId,
        externalReplyDetectedAt: { $gte: new Date(now - FOLLOW_UP_LOOKBACK_DAYS * DAY_MS), $lte: new Date(now - NUDGE_DAYS * DAY_MS) },
        fromRole: { $in: ['customer', 'external_other'] },
        expectedNextAction: 'company_reply',
        conversationId: { $exists: true, $ne: '' },
      })
      .sort({ externalReplyDetectedAt: 1 })
      .limit(300)
      .exec();
    const seenConversations = new Set<string>();
    for (const item of answeredInOutlook) {
      if (reminded.has(item._id.toString()) || seenConversations.has(item.conversationId!)) continue;
      seenConversations.add(item.conversationId!);
      const repliedAt = item.externalReplyDetectedAt!;
      // The customer wrote again after our reply: not waiting on them.
      if (await this.itemModel.exists({ userId, conversationId: item.conversationId, receivedAt: { $gt: repliedAt }, fromRole: { $ne: 'internal' } })) continue;
      const waited = days(repliedAt);
      rows.push({
        id: `nudge-${item._id.toString()}`,
        bucket: waited >= NUDGE_OVERDUE_DAYS ? 'overdue_follow_up' : 'follow_up_required',
        kind: 'awaiting_customer',
        emailId: item._id.toString(),
        ...customerOf(item),
        subject: item.subject || '(no subject)',
        lastCustomerMessage: { preview: item.bodyPreview, at: item.receivedAt },
        lastResponseAt: repliedAt,
        daysWaiting: waited,
        reason: `You replied ${waited} days ago and the customer hasn’t written back.`,
        suggestedAction: 'Send a short follow-up to keep the conversation moving.',
        priority: waited >= NUDGE_OVERDUE_DAYS ? 'high' : 'medium',
      });
    }

    const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
    rows.sort((a, b) => rank[a.priority] - rank[b.priority] || b.daysWaiting - a.daysWaiting);
    const responded = await this.itemModel
      .countDocuments({
        userId,
        $or: [{ sentAt: { $exists: true } }, { externalReplyDetectedAt: { $exists: true } }, { threadRespondedAt: { $exists: true } }],
      })
      .exec();
    return {
      counts: {
        responded,
        not_responded: rows.filter((r) => r.bucket === 'not_responded').length,
        follow_up_required: rows.filter((r) => r.bucket === 'follow_up_required').length,
        overdue_follow_up: rows.filter((r) => r.bucket === 'overdue_follow_up').length,
      },
      rows,
    };
  }

  /** Turns an "awaiting the customer" row into a real reminder, so the existing draft → approve → send flow applies to it. */
  async ensureReminder(userId: string, emailId: string): Promise<EmailFollowUpReminderDocument> {
    const item = await this.itemModel.findOne({ _id: emailId, userId }).exec();
    if (!item) throw new BadRequestException('That email could not be found.');
    const filter = { organizationId: item.organizationId, emailIntelligenceItemId: item._id.toString(), reminderType: 'post_reply' };
    await this.reminderModel
      .updateOne(
        filter,
        {
          $setOnInsert: {
            ...filter,
            userId,
            businessName: item.matchedBusinessName,
            title: `Follow up: ${item.subject || '(no subject)'}`,
            dueDate: new Date(),
            status: 'pending',
            draftStatus: 'none',
          },
        },
        { upsert: true },
      )
      .exec();
    const reminder = (await this.reminderModel.findOne(filter).exec())!;
    // One reminder per email: when the earlier follow-up was sent, done or dismissed and the
    // conversation is due another, the same reminder starts a new round rather than staying closed
    // (a closed one can't be drafted, isn't listed, and refuses to be sent a second time).
    if (reminder.status !== 'pending' || reminder.sentAt) {
      reminder.status = 'pending';
      reminder.draftStatus = 'none';
      reminder.draftReply = undefined;
      reminder.draftGeneratedAt = undefined;
      reminder.sentAt = undefined;
      reminder.sendError = undefined;
      reminder.dueDate = new Date();
      await reminder.save();
    }
    return reminder;
  }
}
