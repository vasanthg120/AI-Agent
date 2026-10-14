import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { CustomerActivityService, TodaysEmail } from '../crm/customer-activity.service';
import { OutlookConnection, OutlookConnectionDocument } from '../outlook/schemas/outlook-connection.schema';
import { UsersService } from '../users/users.service';
import { EmailSyncJob, EmailSyncJobDocument } from './schemas/email-sync-job.schema';
import { EmailConversationService } from './email-conversation.service';
import { EmailHistoryService, SentMessage } from './email-history.service';
import { analysisFailureReason, AUTO_DRAFT_MAX_AGE_DAYS, EmailIntelligenceService } from './email-intelligence.service';

export interface SyncMailboxResult {
  connected: boolean;
  scannedCount: number;
  newItemsCount: number;
  /** New mail stored without an AI reading (no credits / AI unavailable); it is tracked and retried. */
  deferredCount?: number;
  /** Emails found to have been answered in Outlook. */
  answeredCount?: number;
  /** Another sync of this mailbox was already running, so this one did nothing. */
  alreadyRunning?: boolean;
}

export interface ReplyRefreshResult {
  connected: boolean;
  /** Emails newly found answered. */
  answered: number;
  /** False when the mailbox was checked moments ago and this call was skipped. */
  checked: boolean;
}

interface InboxResponse {
  connected: boolean;
  emails: TodaysEmail[];
  truncated?: boolean;
  mailboxAddresses?: string[];
}

interface SentResponse {
  connected: boolean;
  items: SentMessage[];
  truncated?: boolean;
  mailboxAddresses?: string[];
}

// Phase 21 follow-up — a genuinely richer response, no longer the same
// shape as SyncMailboxResult: breaks "new" down into what's already stored,
// what the deterministic gates would auto-skip (no LLM cost), and what
// would actually spend a real AI call, plus a real (not guessed) token
// estimate once history exists.
export interface SyncPreviewResult {
  connected: boolean;
  scannedCount: number;
  alreadyAnalyzedCount: number;
  autoSkippedCount: number;
  willAnalyzeCount: number;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedBasis: 'historical_average' | 'no_history';
  lastSyncedAt: string | null;
}

export interface ProviderHealthStatus {
  provider: 'anthropic' | 'groq';
  status: 'available' | 'degraded' | 'unknown';
  lastCheckedAt: string | null;
  lastError: string | null;
}

// How many recent real email_analyze calls to average over for the token
// estimate — small enough to react to a recent shift (e.g. longer threads),
// large enough not to be thrown off by one unusually long/short email.
const HISTORY_SAMPLE_SIZE = 20;

// Two ways in: a button-triggered sync scoped to the calling user's own
// mailbox (EmailIntelligenceController's POST /sync route), and a
// background sweep across every connected mailbox (runScheduledSync below,
// @Cron every 30 minutes) — both call syncMyMailbox, both go through the
// exact same resolveSyncSince/pre-filter/dedup path, so the two can never
// classify the same mail differently. The background sweep replaces an
// earlier always-on 3-minute cron that was removed for being the single
// largest automatic LLM cost driver in the app (confirmed live: 56 real
// Claude calls from this one feature alone, running whether or not anyone
// was using the app) — 30 minutes is a deliberately longer interval, chosen
// to keep mailboxes reasonably fresh without reintroducing that cost. A
// generous rolling lookback (not a persisted watermark/cursor) is what
// makes repeated syncs — clicked or scheduled — safe and cheap:
// EmailIntelligenceItem's unique index on {userId, externalMessageId} means
// re-scanning the same window twice only costs one exists() check per
// already-seen message, never a second LLM call.
const SYNC_LOOKBACK_HOURS = 24;

// Bounds how far a single sync click can backfill when the mailbox owner
// hasn't clicked Sync in a while — see resolveSyncSince below for why this
// is needed at all (the fixed 24h lookback above silently left a gap for
// anyone who went longer than a day between clicks, which is the common
// case, not the exception, for a button nobody is nagged to click). Bounded
// so a mailbox that hasn't been synced in months can't force one click into
// scanning months of history (Graph load, and a much bigger single-page
// $top:100/250 truncation risk — see messages_since's own comment).
const MAX_SYNC_BACKFILL_DAYS = 14;

// External-reply detection's own lookback cap — bounds how far back the
// Sent Items fetch can reach even if a pending item has sat unanswered
// (by this app's own tracking) for a very long time, so one old stray item
// can never force an unbounded Graph query.
const EXTERNAL_REPLY_LOOKBACK_DAYS = 180;

// How far back each sync reads Sent Items to keep them (idempotent — already-stored messages are skipped).
const SENT_KEEP_LOOKBACK_DAYS = 3;

// Each sync re-reads this much before the previous run's START. Mail that
// arrived while that run was reading the mailbox would otherwise fall between
// the two windows; re-reading is free, since stored messages are skipped.
const SYNC_OVERLAP_MINUTES = 15;
// A 'running' sync older than this is a crashed process, not a sync in progress.
const SYNC_LOCK_STALE_MS = 15 * 60_000;
// The reply check (Sent Items only, no AI) runs at most this often per mailbox.
const REPLY_REFRESH_MIN_INTERVAL_MS = 45_000;
// AI readings retried per sync for mail stored while the AI was unavailable.
const ANALYSIS_RETRY_BATCH = 15;
// Open conversations checked against the mailbox (deleted / moved) per sync.
const MAILBOX_CHECK_BATCH = 100;
// Drafts written per auto-draft pass (each one is a billed AI call), and the most a single click may ask for.
export const AUTO_DRAFT_BATCH = 10;
const DRAFT_RUN_MAX = 25;

/** What one drafting run did. */
export interface DraftRunResult {
  startedAt: Date;
  finishedAt?: Date;
  /** Emails the AI wrote a reply for. */
  drafted: number;
  /** Emails the AI read and wrote nothing for: no reply is needed, or it is one to write by hand. */
  noDraft: number;
  /** Why the run stopped early, in words a person can act on (credits used up, the AI unreachable). */
  error?: string;
}

@Injectable()
export class EmailIntelligenceSyncService {
  private readonly logger = new Logger(EmailIntelligenceSyncService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(OutlookConnection.name) private connectionModel: Model<OutlookConnectionDocument>,
    @InjectModel(EmailSyncJob.name) private syncJobModel: Model<EmailSyncJobDocument>,
    @InjectModel(AgentExecution.name) private agentExecutionModel: Model<AgentExecutionDocument>,
    private usersService: UsersService,
    private customerActivityService: CustomerActivityService,
    private emailIntelligenceService: EmailIntelligenceService,
    private emailHistory: EmailHistoryService,
    private conversations: EmailConversationService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  // The real fix for "I synced 9 days ago, clicked Sync, and still see no
  // records" — a flat rolling 24h lookback (the old behavior) means anyone
  // who goes more than a day between clicks permanently loses everything
  // outside that last day; the button was never a backfill, only a
  // heartbeat. Instead this looks back to the last successful sync (so a
  // gap of any size gets closed, not just today's), falling back to the
  // 24h floor for a mailbox that's never been synced, and clamped to
  // MAX_SYNC_BACKFILL_DAYS so a very stale mailbox still costs one bounded
  // scan rather than an unbounded one. Only 'completed'/'completed_with_errors'
  // jobs count as a real scan boundary — a 'failed' run (e.g. python-agent
  // was unreachable) never actually looked at Graph, so treating its
  // completedAt as "already covered" would silently skip the very window it
  // failed to cover.
  private async resolveSyncSince(userId: string): Promise<string> {
    const lastGoodJob = await this.syncJobModel
      .findOne({ userId, status: { $in: ['completed', 'completed_with_errors'] } })
      .sort({ createdAt: -1 })
      .exec();
    const floor = new Date(Date.now() - SYNC_LOOKBACK_HOURS * 60 * 60_000);
    const cap = new Date(Date.now() - MAX_SYNC_BACKFILL_DAYS * 24 * 60 * 60_000);
    // From the previous run's START (not its end), less an overlap: mail that
    // arrived while that run was still reading the mailbox is read again here.
    const lastStart = lastGoodJob ? new Date(lastGoodJob.startedAt.getTime() - SYNC_OVERLAP_MINUTES * 60_000) : null;
    let candidate = lastStart ?? floor;
    // A run that could not store some of the mail it read leaves a hole behind
    // it. Until a later run has read that window again without failures, every
    // sync reaches back to it — so mail is never silently skipped for good.
    const unrecovered = await this.syncJobModel
      .findOne({ userId, failedCount: { $gt: 0 }, failuresRecovered: { $ne: true }, startedAt: { $gte: cap } })
      .sort({ startedAt: 1 })
      .exec();
    if (unrecovered) {
      const hole = unrecovered.windowStart ?? new Date(unrecovered.startedAt.getTime() - SYNC_LOOKBACK_HOURS * 60 * 60_000);
      if (hole < candidate) candidate = hole;
    }
    return (candidate < cap ? cap : candidate).toISOString();
  }

  // Cheap, LLM-free — same connection/lookback/fetch as syncMyMailbox but
  // stops short of ever calling analyzeAndCreate. Deliberately skips
  // gatherCorrelationContext too (only needed to build analyzeAndCreate's
  // context, not to count), so this is meaningfully cheaper than a real
  // sync, not just "the loop minus the LLM call". Phase 21 follow-up: also
  // dry-runs the same deterministic skip gates the real sync applies (via
  // wouldSkipLlmAnalysis), so "will analyze" reflects what will actually
  // happen, not just "not seen before" — and pulls a real historical-average
  // token estimate rather than ever guessing one.
  async previewSync(userId: string): Promise<SyncPreviewResult> {
    const notConnected: SyncPreviewResult = {
      connected: false,
      scannedCount: 0,
      alreadyAnalyzedCount: 0,
      autoSkippedCount: 0,
      willAnalyzeCount: 0,
      estimatedInputTokens: null,
      estimatedOutputTokens: null,
      estimatedBasis: 'no_history',
      lastSyncedAt: null,
    };
    const user = await this.usersService.findById(userId);
    const connection = await this.connectionModel.findOne({ userId, isActive: true }).exec();
    if (!user || !connection) return notConnected;

    const since = await this.resolveSyncSince(userId);
    const token = this.jwt.sign({ sub: userId }, { expiresIn: '5m' });
    const { data } = await firstValueFrom(
      this.http.get<{ connected: boolean; emails: TodaysEmail[] }>(`${this.pythonAgentUrl}/outlook/messages-since`, {
        params: { since },
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (!data.connected) return notConnected;

    let alreadyAnalyzedCount = 0;
    let autoSkippedCount = 0;
    let willAnalyzeCount = 0;
    const ownAddresses = await this.conversations.rememberAddresses(userId, connection.email, (data as InboxResponse).mailboxAddresses);
    for (const email of data.emails) {
      const exists = await this.emailIntelligenceService.alreadyStored(userId, email);
      if (exists) {
        alreadyAnalyzedCount += 1;
        continue;
      }
      if (this.emailIntelligenceService.wouldSkipLlmAnalysis(email, connection.email, ownAddresses)) {
        autoSkippedCount += 1;
      } else {
        willAnalyzeCount += 1;
      }
    }

    const [estimate, lastJob] = await Promise.all([
      this.estimateTokenUsage(user.organizationId, willAnalyzeCount),
      this.syncJobModel
        .findOne({ userId, status: { $ne: 'running' } })
        .sort({ createdAt: -1 })
        .exec(),
    ]);

    return {
      connected: true,
      scannedCount: data.emails.length,
      alreadyAnalyzedCount,
      autoSkippedCount,
      willAnalyzeCount,
      estimatedInputTokens: estimate.inputTokens,
      estimatedOutputTokens: estimate.outputTokens,
      estimatedBasis: estimate.basis,
      lastSyncedAt: lastJob?.completedAt?.toISOString() ?? null,
    };
  }

  // Averages real token counts from this org's own recent, successful
  // email_analyze calls (see anthropic_client.py's Phase 21 follow-up
  // tracing addition) — never a flat guessed constant. No history yet
  // (a fresh org, or before that tracing shipped) means an honest "we don't
  // know yet" rather than a fabricated number.
  private async estimateTokenUsage(
    organizationId: string,
    willAnalyzeCount: number,
  ): Promise<{ inputTokens: number | null; outputTokens: number | null; basis: 'historical_average' | 'no_history' }> {
    if (willAnalyzeCount === 0) return { inputTokens: 0, outputTokens: 0, basis: 'no_history' };

    const recent = await this.agentExecutionModel
      .find({ organizationId, name: 'email_analyze', success: true })
      .sort({ occurredAt: -1 })
      .limit(HISTORY_SAMPLE_SIZE)
      .exec();
    if (recent.length === 0) return { inputTokens: null, outputTokens: null, basis: 'no_history' };

    const avgInput = recent.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0) / recent.length;
    const avgOutput = recent.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0) / recent.length;
    return {
      inputTokens: Math.round(avgInput * willAnalyzeCount),
      outputTokens: Math.round(avgOutput * willAnalyzeCount),
      basis: 'historical_average',
    };
  }

  // Derived from this org's own real recent call telemetry, never a live
  // ping (no extra cost, always available) — the most recent llm-kind
  // execution per provider tells us whether the last real attempt succeeded.
  // 'unknown' (not "available") when no history exists yet, so an untested
  // provider is never presented as confirmed healthy.
  async getProviderHealth(organizationId: string): Promise<ProviderHealthStatus[]> {
    const providers: ('anthropic' | 'groq')[] = ['anthropic', 'groq'];
    return Promise.all(
      providers.map(async (provider) => {
        const latest = await this.agentExecutionModel.findOne({ organizationId, provider, kind: 'llm' }).sort({ occurredAt: -1 }).exec();
        if (!latest) return { provider, status: 'unknown' as const, lastCheckedAt: null, lastError: null };
        return {
          provider,
          status: latest.success ? ('available' as const) : ('degraded' as const),
          lastCheckedAt: latest.occurredAt?.toISOString() ?? null,
          lastError: latest.success ? null : (latest.error ?? null),
        };
      }),
    );
  }

  private graphToken(userId: string): string {
    return this.jwt.sign({ sub: userId }, { expiresIn: '5m' });
  }

  // In-process guard for the cheap reply check (the full sync takes a real,
  // cross-process lock — see acquireSyncLock).
  private readonly replyRefreshes = new Map<string, { at: number; running?: Promise<ReplyRefreshResult> }>();

  // One sync per mailbox at a time, across every backend process: the lock is
  // the 'running' job document itself, made unique per user by an index. A
  // crashed run's lock is released once it is clearly stale.
  private async acquireSyncLock(
    organizationId: string,
    userId: string,
    triggeredBy: 'user' | 'scheduled',
    startedAt: Date,
    windowStart: Date,
  ): Promise<EmailSyncJobDocument | null> {
    await this.syncJobModel
      .updateMany(
        { userId, status: 'running', startedAt: { $lt: new Date(startedAt.getTime() - SYNC_LOCK_STALE_MS) } },
        { $set: { status: 'failed', completedAt: startedAt, error: 'The sync stopped before finishing.' } },
      )
      .exec();
    try {
      return await this.syncJobModel.create({ organizationId, userId, status: 'running', triggeredBy, startedAt, windowStart });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  // Reads Sent Items since `since`, keeps them, and learns the mailbox's own
  // addresses. Returns false when Outlook is not connected.
  private async pullSent(userId: string, organizationId: string, mailboxEmail: string): Promise<boolean> {
    const oldestPending = await this.emailIntelligenceService.getEarliestPendingReceivedAt(userId);
    // Sent mail is also kept (the Sent view, promised follow-ups), so recent
    // Sent Items are read even when nothing is waiting for a reply.
    const recent = new Date(Date.now() - SENT_KEEP_LOOKBACK_DAYS * 24 * 60 * 60_000);
    const lookbackFloor = new Date(Date.now() - EXTERNAL_REPLY_LOOKBACK_DAYS * 24 * 60 * 60_000);
    const oldest = oldestPending && oldestPending < recent ? oldestPending : recent;
    const since = (oldest < lookbackFloor ? lookbackFloor : oldest).toISOString();

    const { data } = await firstValueFrom(
      this.http.get<SentResponse>(`${this.pythonAgentUrl}/outlook/sent-since`, {
        params: { since },
        headers: { Authorization: `Bearer ${this.graphToken(userId)}` },
      }),
    );
    if (!data.connected) return false;
    await this.conversations.rememberAddresses(userId, mailboxEmail, data.mailboxAddresses);
    await this.emailHistory.storeSent(organizationId, userId, mailboxEmail, data.items);
    return true;
  }

  /**
   * The cheap, AI-free half of a sync: reads the mailbox's Sent Items and
   * settles which conversations have been answered. This is what makes a
   * reply typed in Outlook show up here within a couple of minutes — it runs
   * on a short timer and whenever the inbox page is open, and costs one
   * Outlook request. It never reads new inbound mail and never calls the AI.
   */
  async refreshReplies(userId: string, options: { force?: boolean } = {}): Promise<ReplyRefreshResult> {
    const state = this.replyRefreshes.get(userId);
    if (state?.running) return state.running;
    if (!options.force && state && Date.now() - state.at < REPLY_REFRESH_MIN_INTERVAL_MS) return { connected: true, answered: 0, checked: false };

    const running = (async (): Promise<ReplyRefreshResult> => {
      const user = await this.usersService.findById(userId);
      const connection = await this.connectionModel.findOne({ userId, isActive: true }).exec();
      if (!user || !connection || connection.status === 'needs_reauth') return { connected: false, answered: 0, checked: true };
      if (!(await this.pullSent(userId, user.organizationId, connection.email))) return { connected: false, answered: 0, checked: true };
      const { answered } = await this.conversations.reconcile(userId);
      if (answered > 0) await this.emailHistory.maintainFollowUps(userId).catch(() => undefined);
      return { connected: true, answered, checked: true };
    })();
    this.replyRefreshes.set(userId, { at: Date.now(), running });
    try {
      return await running;
    } finally {
      this.replyRefreshes.set(userId, { at: Date.now() });
    }
  }

  // Every 2 minutes, for every connected mailbox that has something waiting:
  // has it been answered in Outlook? No AI, one Outlook request per mailbox.
  @Cron('*/2 * * * *')
  async runScheduledReplyRefresh(): Promise<void> {
    const connections = await this.connectionModel
      .find({ isActive: true, status: { $ne: 'needs_reauth' } })
      .select('userId')
      .lean()
      .exec();
    for (const connection of connections) {
      try {
        if (!(await this.emailIntelligenceService.getEarliestPendingReceivedAt(connection.userId))) continue;
        await this.refreshReplies(connection.userId);
      } catch (err) {
        this.logger.warn(`Reply check failed for user ${connection.userId}: ${(err as Error).message}`);
      }
    }
  }

  // Asks Outlook where the still-waiting messages are now: one that was
  // deleted stops waiting, one that was moved keeps working under its new id.
  private async checkMailboxState(userId: string): Promise<void> {
    const open = await this.emailIntelligenceService.listOpenForMailboxCheck(userId, MAILBOX_CHECK_BATCH);
    if (open.length === 0) return;
    const { data } = await firstValueFrom(
      this.http.post<{ connected: boolean; states: { id: string; state: string; newId?: string | null; isRead?: boolean | null }[] }>(
        `${this.pythonAgentUrl}/outlook/messages-state`,
        { messages: open.map((o) => ({ id: o.externalMessageId, internetMessageId: o.internetMessageId ?? null })) },
        { headers: { Authorization: `Bearer ${this.graphToken(userId)}` } },
      ),
    );
    if (!data.connected) return;
    const removed = await this.emailIntelligenceService.applyMailboxStates(userId, data.states);
    if (removed > 0) this.logger.log(`Mailbox of user ${userId}: ${removed} waiting email(s) were deleted in Outlook and no longer count as waiting`);
  }

  // Scoped to exactly one user's own connected mailbox. The order matters:
  //   1. Sent Items first, so a new email that was already answered in Outlook
  //      is stored as answered — no AI call, no "needs a reply" notification.
  //   2. Received mail, wherever it sits in the mailbox. Every new message is
  //      stored; the AI reads the ones that need reading, and a message the AI
  //      could not read is stored anyway (tracked, flagged, retried later).
  //   3. The response-state engine settles which conversations are answered
  //      and groups each conversation under its newest customer message.
  //   4. Housekeeping: read state, deleted/moved mail, AI retries, follow-ups.
  // Each later step is best-effort — one failing never undoes the ones before.
  async syncMyMailbox(userId: string, triggeredBy: 'user' | 'scheduled' = 'user'): Promise<SyncMailboxResult> {
    const startedAt = new Date();
    const user = await this.usersService.findById(userId);
    const connection = await this.connectionModel.findOne({ userId, isActive: true }).exec();
    if (!user || !connection) return { connected: false, scannedCount: 0, newItemsCount: 0 };

    // The window is worked out before the lock is taken: the lock is itself a job document.
    const since = await this.resolveSyncSince(userId);
    const job = await this.acquireSyncLock(user.organizationId, userId, triggeredBy, startedAt, new Date(since));
    if (!job) return { connected: true, scannedCount: 0, newItemsCount: 0, alreadyRunning: true };

    const finish = async (fields: Partial<EmailSyncJob>) => {
      try {
        await this.syncJobModel.updateOne({ _id: job._id }, { $set: { ...fields, completedAt: new Date() } }).exec();
      } catch (err) {
        this.logger.error(`Failed to record the sync result for user ${userId}: ${(err as Error).message}`);
      }
    };

    try {
      if (!(await this.pullSent(userId, user.organizationId, connection.email))) {
        await finish({ status: 'failed', error: 'Outlook is not connected.' });
        return { connected: false, scannedCount: 0, newItemsCount: 0 };
      }
      const { data } = await firstValueFrom(
        this.http.get<InboxResponse>(`${this.pythonAgentUrl}/outlook/messages-since`, {
          params: { since },
          headers: { Authorization: `Bearer ${this.graphToken(userId)}` },
        }),
      );
      if (!data.connected) {
        await finish({ status: 'failed', error: 'Outlook is not connected.' });
        return { connected: false, scannedCount: 0, newItemsCount: 0 };
      }
      const ownAddresses = await this.conversations.rememberAddresses(userId, connection.email, data.mailboxAddresses);
      const context = await this.customerActivityService.gatherCorrelationContext(user.organizationId);
      const replies = await this.conversations.replyIndex(userId, new Date(new Date(since).getTime() - 60 * 60_000), ownAddresses);

      let newItemsCount = 0;
      let succeededCount = 0;
      let failedCount = 0;
      let deferredCount = 0;
      const alreadyStored: { id: string; isRead: boolean }[] = [];
      const touchedConversations = new Set<string>();
      // Oldest first, so each message is read by the AI with the earlier ones of its conversation already stored.
      const emails = [...data.emails].sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
      for (const email of emails) {
        if (!email.id || !email.receivedAt) continue;
        if (await this.emailIntelligenceService.alreadyStored(userId, email)) {
          alreadyStored.push({ id: email.id, isRead: email.isRead });
          continue;
        }
        newItemsCount += 1;
        try {
          const receivedAt = new Date(email.receivedAt);
          const reply = replies.findReply({
            receivedAt,
            conversationId: email.conversationId,
            internetMessageId: email.internetMessageId,
            fromAddress: email.from,
            subject: email.subject,
          });
          const created = await this.emailIntelligenceService.analyzeAndCreate(user.organizationId, userId, connection.email, email, context, {
            ownAddresses,
            answered: reply ? this.conversations.answeredFields(reply) : undefined,
            thread: reply ? undefined : await this.conversations.threadContext(userId, email.conversationId, receivedAt),
          });
          if (created?.analysisState === 'pending') deferredCount += 1;
          succeededCount += 1;
          if (email.conversationId) touchedConversations.add(email.conversationId);
        } catch (err) {
          failedCount += 1;
          this.logger.error(`Could not store message ${email.id} for user ${userId}: ${(err as Error).message}`);
        }
      }

      let answeredCount = 0;
      const step = async (name: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (err) {
          this.logger.error(`${name} failed for user ${userId}: ${(err as Error).message}`);
        }
      };
      await step('Conversation state', async () => {
        answeredCount = await this.conversations.applyReplies(userId);
        // Everything on the first run after this was introduced; afterwards only what changed.
        await this.conversations.refreshThreadHeads(userId, (await this.groupingIsCurrent(userId)) ? [...touchedConversations] : undefined);
      });
      await step('Read-state refresh', async () => {
        await this.emailIntelligenceService.refreshReadState(userId, alreadyStored);
      });
      await step('Mailbox check', () => this.checkMailboxState(userId));
      await step('AI retry', async () => {
        deferredCount = Math.max(0, deferredCount - (await this.retryDeferredAnalysis(userId, context, ownAddresses, deferredCount > 0)));
      });
      // Only for a mailbox whose owner switched it on: drafts for recent mail still waiting without one.
      await step('Auto-draft', async () => {
        if (!(await this.emailIntelligenceService.getInboxSettings(userId)).autoDraft) return;
        await this.draftWaiting(userId, { limit: AUTO_DRAFT_BATCH, maxAgeDays: AUTO_DRAFT_MAX_AGE_DAYS, context, ownAddresses });
      });
      // Promised follow-ups that never went out, and reminders the mailbox
      // shows are no longer needed — read from the threads, no AI call.
      await step('Follow-up maintenance', () => this.emailHistory.maintainFollowUps(userId));

      const result: SyncMailboxResult = { connected: true, scannedCount: data.emails.length, newItemsCount, deferredCount, answeredCount };
      await finish({
        status: failedCount > 0 ? 'completed_with_errors' : 'completed',
        scannedCount: result.scannedCount,
        newItemsCount,
        succeededCount,
        failedCount,
        deferredCount,
        answeredCount,
        truncated: !!data.truncated,
      });
      // This run read its whole window and stored everything: earlier holes inside it are closed.
      if (failedCount === 0 && !data.truncated) {
        await this.syncJobModel
          .updateMany(
            { userId, _id: { $ne: job._id }, failedCount: { $gt: 0 }, failuresRecovered: { $ne: true }, startedAt: { $lt: startedAt } },
            { $set: { failuresRecovered: true } },
          )
          .exec()
          .catch(() => undefined);
      }
      this.logger.log(
        `Mailbox sync for user ${userId} (${triggeredBy}): ${data.emails.length} read, ${newItemsCount} new, ${deferredCount} awaiting AI, ${answeredCount} found answered, ${failedCount} failed`,
      );
      return result;
    } catch (err) {
      // The sync itself failed (python-agent unreachable, Outlook refused) — the
      // window it meant to cover is NOT counted as covered (see resolveSyncSince).
      await finish({ status: 'failed', error: (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  // ---- AI drafts for mail that is waiting without one ---------------------------------
  //
  // New mail is read and drafted by the AI as it is synced. This is for the
  // rest: mail brought in from mailbox history, or that arrived while the AI
  // was unavailable — waiting for a reply with nothing drafted. A run works
  // through them newest first, one billed AI call each, and stops at the first
  // failure (no credits, an outage): the next email would fail the same way.

  // One run per mailbox at a time, so a click and the background pass can never draft the same email twice.
  private draftRuns = new Map<string, DraftRunResult>();
  private drafting = new Set<string>();

  /** Whether a run is under way for this mailbox, and what the last one did. */
  draftRunState(userId: string): { running: boolean; last: DraftRunResult | null } {
    return { running: this.drafting.has(userId), last: this.draftRuns.get(userId) ?? null };
  }

  /** Runs in the background; the caller watches draftRunState. False when one is already running. */
  startDraftRun(userId: string, options: { limit?: number; maxAgeDays?: number } = {}): boolean {
    if (this.drafting.has(userId)) return false;
    void this.draftWaiting(userId, options).catch((err) => this.logger.error(`Draft run failed for user ${userId}: ${(err as Error).message}`));
    return true;
  }

  async draftWaiting(
    userId: string,
    options: {
      limit?: number;
      maxAgeDays?: number;
      context?: Awaited<ReturnType<CustomerActivityService['gatherCorrelationContext']>>;
      ownAddresses?: string[];
    } = {},
  ): Promise<DraftRunResult | null> {
    if (this.drafting.has(userId)) return null;
    this.drafting.add(userId);
    const run: DraftRunResult = { startedAt: new Date(), drafted: 0, noDraft: 0 };
    this.draftRuns.set(userId, run);
    try {
      const limit = Math.min(Math.max(Math.round(options.limit ?? AUTO_DRAFT_BATCH), 1), DRAFT_RUN_MAX);
      const waiting = await this.emailIntelligenceService.listWithoutDraft(userId, limit, options.maxAgeDays);
      if (waiting.length === 0) return run;
      const user = await this.usersService.findById(userId);
      if (!user) return run;
      const context = options.context ?? (await this.customerActivityService.gatherCorrelationContext(user.organizationId));
      const ownAddresses = options.ownAddresses ?? (await this.conversations.ownAddresses(userId));
      for (const item of waiting) {
        try {
          // The AI reads the whole conversation so far, not just this one message.
          const thread = await this.conversations.threadContext(userId, item.conversationId, item.receivedAt, item._id.toString());
          const read = await this.emailIntelligenceService.regenerate(userId, item._id.toString(), context, { ownAddresses, thread });
          if (read.draftReply?.trim()) run.drafted += 1;
          else run.noDraft += 1;
        } catch (err) {
          run.error = analysisFailureReason(err);
          this.logger.warn(`Draft run for user ${userId} stopped: ${(err as Error).message}`);
          break;
        }
      }
      return run;
    } finally {
      run.finishedAt = new Date();
      this.drafting.delete(userId);
    }
  }

  // Whether every stored conversation already has its grouping (threadHead)
  // worked out — false on a mailbox synced before grouping existed.
  private groupedUsers = new Set<string>();
  private async groupingIsCurrent(userId: string): Promise<boolean> {
    if (this.groupedUsers.has(userId)) return true;
    this.groupedUsers.add(userId);
    return false;
  }

  // Mail stored while the AI was unavailable gets its AI reading once the AI
  // is back. Stops at the first failure — if credits are still out there is no
  // point asking again for each email. Returns how many were read.
  private async retryDeferredAnalysis(
    userId: string,
    context: Awaited<ReturnType<CustomerActivityService['gatherCorrelationContext']>>,
    ownAddresses: string[],
    justFailed: boolean,
  ): Promise<number> {
    if (justFailed) return 0; // the AI was unavailable seconds ago in this very run
    const waiting = await this.emailIntelligenceService.listAwaitingAnalysis(userId, ANALYSIS_RETRY_BATCH);
    let read = 0;
    for (const item of waiting) {
      try {
        const thread = await this.conversations.threadContext(userId, item.conversationId, item.receivedAt, item._id.toString());
        await this.emailIntelligenceService.regenerate(userId, item._id.toString(), context, { ownAddresses, thread });
        read += 1;
      } catch (err) {
        this.logger.warn(`AI still unavailable for user ${userId}: ${(err as Error).message}`);
        break;
      }
    }
    return read;
  }

  // Background sync of every connected mailbox, every 30 minutes — the same
  // syncMyMailbox a click runs. One mailbox's failure (expired token, an
  // Outlook hiccup) never stops the sweep for everyone else. Replies typed in
  // Outlook do not wait for this: see runScheduledReplyRefresh.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async runScheduledSync(): Promise<void> {
    const connections = await this.connectionModel.find({ isActive: true, status: { $ne: 'needs_reauth' } }).exec();
    for (const connection of connections) {
      try {
        await this.syncMyMailbox(connection.userId, 'scheduled');
      } catch (err) {
        this.logger.error(`Scheduled sync failed for user ${connection.userId}: ${(err as Error).message}`);
      }
    }
  }

  // Recent sync history for the caller's own mailbox — self-scoped, matches
  // every other read on this module.
  async listRecentSyncJobs(userId: string, limit = 20): Promise<EmailSyncJobDocument[]> {
    return this.syncJobModel.find({ userId }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /** When this mailbox last finished a sync, and whether one is running now. */
  async syncState(userId: string): Promise<{ lastSyncedAt: Date | null; running: boolean; awaitingAnalysis: number }> {
    const [last, running, awaiting] = await Promise.all([
      this.syncJobModel
        .findOne({ userId, status: { $in: ['completed', 'completed_with_errors'] } })
        .sort({ createdAt: -1 })
        .select('completedAt')
        .lean()
        .exec(),
      this.syncJobModel.exists({ userId, status: 'running' }),
      this.emailIntelligenceService.listAwaitingAnalysis(userId, 200),
    ]);
    return { lastSyncedAt: last?.completedAt ?? null, running: !!running, awaitingAnalysis: awaiting.length };
  }
}
