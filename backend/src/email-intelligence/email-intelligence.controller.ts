import { BadRequestException, Body, Controller, ForbiddenException, Get, Logger, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CustomerActivityService } from '../crm/customer-activity.service';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailConversationService } from './email-conversation.service';
import { EmailHistoryService } from './email-history.service';
import { AUTO_DRAFT_BATCH, EmailIntelligenceSyncService } from './email-intelligence-sync.service';
import { EmailResponseStatus } from './email-response-state';
import { AUTO_DRAFT_MAX_AGE_DAYS, EmailIntelligenceService, ListEmailsQuery } from './email-intelligence.service';
import { Feature } from '../common/app-features';
import { FeatureGuard } from '../common/guards/feature.guard';

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
const RESPONSE_VIEWS: EmailResponseStatus[] = ['needs_response', 'responded', 'resolved'];
const SORTS = ['urgency', 'newest', 'oldest'] as const;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function nonNegativeInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException(`${name} must be a non-negative integer`);
  return n;
}

// Every filter is optional; the ones that name a fixed vocabulary are checked
// rather than passed through, so a typo is a 400, not an empty list that looks
// like "nothing needs a reply".
function parseListQuery(raw: Record<string, string | undefined>): ListEmailsQuery {
  return {
    status: oneOf(raw.status, APPROVAL_STATUSES, 'status'),
    view: oneOf(raw.view, RESPONSE_VIEWS, 'view'),
    sort: oneOf(raw.sort, SORTS, 'sort'),
    from: raw.from || undefined,
    to: raw.to || undefined,
    search: raw.search || undefined,
    intents: raw.intents ? raw.intents.split(',').filter(Boolean) : undefined,
    limit: nonNegativeInt(raw.limit, 'limit'),
    skip: nonNegativeInt(raw.skip, 'skip'),
  };
}

// No @Roles()/RolesGuard anywhere in this controller — every authenticated
// user, self-scoped via their own JWT sub. Each item belongs to exactly one
// mailbox owner; there is no org-wide oversight view in this pass (see
// Phase 14b plan notes).
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature('email_inbox')
@Controller('email-intelligence')
export class EmailIntelligenceController {
  constructor(
    private emailIntelligenceService: EmailIntelligenceService,
    private customerActivityService: CustomerActivityService,
    private emailIntelligenceSyncService: EmailIntelligenceSyncService,
    private emailHistory: EmailHistoryService,
    private conversations: EmailConversationService,
  ) {}

  private readonly logger = new Logger(EmailIntelligenceController.name);

  // Phase 21 — cheap, LLM-free count of how many messages-since-lookback are
  // new, so the frontend can show a real confirm-before-spend operation
  // count. Static segment, must be declared before the ':id' GET route
  // below.
  @Get('sync/preview')
  previewSync(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.previewSync(user.sub);
  }

  // Explicit, user-triggered sync — the button click gets an immediate,
  // synchronous result and a real preview-before-spend step (see the
  // /sync/preview route above), unlike EmailIntelligenceSyncService's own
  // background half-hourly sweep (runScheduledSync), which also calls
  // syncMyMailbox but on every connected mailbox, unattended. Static
  // segment, must be declared before the ':id' GET route below.
  @Post('sync')
  sync(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.syncMyMailbox(user.sub, 'user');
  }

  // The cheap reply check: has anything waiting been answered in Outlook?
  // Reads the caller's Sent Items only — no new mail, no AI — so the inbox
  // page can call it whenever it is open. Rate-limited per mailbox server-side.
  @Post('sync/replies')
  refreshReplies(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.refreshReplies(user.sub);
  }

  // When the caller's mailbox was last synced, whether a sync is running now,
  // and how many stored emails are still waiting for an AI reading.
  @Get('sync/state')
  syncState(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.syncState(user.sub);
  }

  // Phase 21 — recent sync-job history for the caller's own mailbox. Static
  // segment, must be declared before the ':id' GET route below.
  @Get('sync/jobs')
  syncJobs(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.listRecentSyncJobs(user.sub);
  }

  // Phase 21 follow-up — org-scoped (not per-mailbox: provider availability
  // is a shared fact, not something tied to one user's connection), derived
  // from real recent call telemetry so a credit/outage issue is visible
  // before the user clicks Sync, not just discovered as a failure after.
  // Static segment, must be declared before the ':id' GET route below.
  @Get('provider-health')
  providerHealth(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceSyncService.getProviderHealth(user.organizationId);
  }

  // The Inbox's three tab badges (Needs Response / Responded / Resolved), under
  // the same date/type/search filters as the list itself. Static segment, must
  // be declared before the ':id' GET route below.
  @Get('counts')
  counts(@CurrentUser() user: JwtPayload, @Query() query: Record<string, string | undefined>) {
    const { from, to, intents, search } = parseListQuery(query);
    return this.emailIntelligenceService.counts(user.sub, { from, to, intents, search });
  }

  // `view` answers "does this still need a reply" (the backend's single
  // definition — see email-response-state.ts); `status` remains the AI-draft
  // approval lifecycle for callers that mean exactly that.
  @Get()
  list(@CurrentUser() user: JwtPayload, @Query() query: Record<string, string | undefined>) {
    return this.emailIntelligenceService.list(user.sub, parseListQuery(query));
  }

  // Phase 19 — Unified Analytics Dashboard's email activity widget. A
  // deliberate, narrow exception to this controller's usual "no oversight
  // view" stance: owner/manager get an org/store-wide aggregate (looping
  // over scoped users' own mailboxes, same shape customer-activity.
  // service.ts's fetchTodaysEmailsForScope already uses), triggered only by
  // an explicit dashboard view they're already authorized to see — not a
  // passive surveillance feed. Takes a raw from/to range (not a calendar
  // month) so the widget's own day-based filter (Today/7 days/custom, etc.)
  // works independently of the rest of the dashboard's month picker.
  // Static segments, must be declared before the ':id' GET route below.
  @Get('activity-stats')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager', 'consultant')
  activityStats(@CurrentUser() user: JwtPayload, @Query('from') from: string, @Query('to') to: string) {
    const [start, end] = this.resolveActivityRange(from, to);
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (canOverride) {
      return this.emailIntelligenceService.getActivityStats(user.organizationId, start, end);
    }
    if (user.roles.includes('manager')) {
      if (!user.storeId) throw new BadRequestException('No store assigned to this account');
      return this.emailIntelligenceService.getActivityStats(user.organizationId, start, end, user.storeId);
    }
    return this.emailIntelligenceService.getActivityStats(user.organizationId, start, end, undefined, user.sub);
  }

  @Get('activity-query')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager', 'consultant')
  activityQuery(
    @CurrentUser() user: JwtPayload,
    @Query('kind') kind: 'sent' | 'missed' | 'intent',
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('intent') intent?: string,
  ) {
    const [start, end] = this.resolveActivityRange(from, to);
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (canOverride) {
      return this.emailIntelligenceService.listActivity(user.organizationId, kind, start, end, undefined, undefined, intent);
    }
    if (user.roles.includes('manager')) {
      if (!user.storeId) throw new BadRequestException('No store assigned to this account');
      return this.emailIntelligenceService.listActivity(user.organizationId, kind, start, end, user.storeId, undefined, intent);
    }
    return this.emailIntelligenceService.listActivity(user.organizationId, kind, start, end, undefined, user.sub, intent);
  }

  // 'to' is pushed to end-of-day, same reasoning list()'s own from/to
  // handling already documents — a date-only value otherwise means midnight
  // and silently excludes that entire day.
  private resolveActivityRange(from: string, to: string): [Date, Date] {
    if (!from || !to) throw new BadRequestException('from and to are required');
    const start = new Date(from);
    // Explicit 'Z' (UTC) end-of-day — `.setHours()` mutates in the server
    // process's local timezone, which drifts hours off this boundary on any
    // server not running in UTC.
    const end = new Date(`${to}T23:59:59.999Z`);
    return [start, end];
  }

  // ---- mailbox history, sent mail, follow-up analysis (EmailHistoryService).
  // Static segments — declared before the ':id' routes below. All self-scoped
  // to the caller's own connected mailbox, like the rest of this controller.

  // How much of the mailbox HaiVE holds and how far back it goes.
  @Get('history/status')
  historyStatus(@CurrentUser() user: JwtPayload) {
    return this.emailHistory.status(user.sub);
  }

  // Loads older inbox + sent mail (no AI calls). Can take a while for a large mailbox.
  @Post('history/import')
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  importHistory(@CurrentUser() user: JwtPayload, @Body() body: { days?: number }) {
    return this.emailHistory.importHistory(user.sub, Number(body?.days));
  }

  @Get('sent')
  listSent(@CurrentUser() user: JwtPayload, @Query() query: Record<string, string | undefined>) {
    return this.emailHistory.listSent(user.sub, {
      search: query.search,
      from: query.from,
      to: query.to,
      skip: query.skip ? Number(query.skip) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }

  // ---- replies: the owner's settings, and AI drafts for mail waiting without one ----
  // Static segments, declared before the ':id' routes below.

  @Get('settings')
  inboxSettings(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceService.getInboxSettings(user.sub);
  }

  @Put('settings')
  async updateInboxSettings(@CurrentUser() user: JwtPayload, @Body() body: { autoDraft?: boolean; sendOnApprove?: boolean }) {
    if (body?.autoDraft === true && user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    const before = await this.emailIntelligenceService.getInboxSettings(user.sub);
    const settings = await this.emailIntelligenceService.updateInboxSettings(user.sub, body ?? {});
    // Just switched on: start on what is already waiting now, instead of at the next sync.
    if (settings.autoDraft && !before.autoDraft)
      this.emailIntelligenceSyncService.startDraftRun(user.sub, { limit: AUTO_DRAFT_BATCH, maxAgeDays: AUTO_DRAFT_MAX_AGE_DAYS });
    return settings;
  }

  // How many waiting emails have a draft, how many don't, and whether drafts are being written now.
  @Get('drafts/summary')
  async draftSummary(@CurrentUser() user: JwtPayload) {
    const [summary, settings] = await Promise.all([
      this.emailIntelligenceService.draftSummary(user.sub),
      this.emailIntelligenceService.getInboxSettings(user.sub),
    ]);
    return { ...summary, settings, ...this.emailIntelligenceSyncService.draftRunState(user.sub) };
  }

  // "Draft with AI" for the mail waiting without a draft: real, billed AI calls — same
  // per-employee switch as the chat. Runs in the background; the summary above reports progress.
  @Post('drafts/run')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  runDrafts(@CurrentUser() user: JwtPayload, @Body() body: { limit?: number }) {
    if (user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    const started = this.emailIntelligenceSyncService.startDraftRun(user.sub, { limit: Number(body?.limit) || AUTO_DRAFT_BATCH });
    return { started, alreadyRunning: !started };
  }

  // Responded / Not responded / Follow-up required / Overdue follow-up, read from the threads.
  @Get('follow-up-analysis')
  followUpAnalysis(@CurrentUser() user: JwtPayload) {
    return this.emailHistory.followUpAnalysis(user.sub);
  }

  // Makes a follow-up row a real reminder so it can be drafted, approved and sent.
  @Post('follow-up-analysis/:emailId/reminder')
  ensureFollowUpReminder(@CurrentUser() user: JwtPayload, @Param('emailId') emailId: string) {
    return this.emailHistory.ensureReminder(user.sub, emailId);
  }

  // Phase 14e — static segment, must be declared before the ':id' GET route
  // below or it would be swallowed as an id param.
  @Get('follow-ups')
  listFollowUps(@CurrentUser() user: JwtPayload) {
    return this.emailIntelligenceService.listFollowUps(user.sub);
  }

  @Post('follow-ups/:id/done')
  markFollowUpDone(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.emailIntelligenceService.markFollowUpDone(user.sub, id);
  }

  // AI Follow-up action layer (additive) — generate -> review -> approve ->
  // send. Drafting on a click is always available; a real, billed AI call —
  // same per-employee switch as the chat. (AI_FOLLOWUP_ACTIONS_ENABLED only
  // governs drafts written automatically when an SLA is breached.)
  @Post('follow-ups/:id/draft')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  generateFollowUpDraft(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (user.aiAccessEnabled === false) {
      throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    }
    return this.emailIntelligenceService.generateFollowUpDraft(user.sub, id);
  }

  @Post('follow-ups/:id/approve')
  approveFollowUpDraft(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: { finalDraftReply?: string }) {
    return this.emailIntelligenceService.approveFollowUpDraft(user.sub, id, body?.finalDraftReply);
  }

  @Post('follow-ups/:id/send')
  sendFollowUp(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.emailIntelligenceService.sendFollowUp(user.sub, id);
  }

  @Post('follow-ups/:id/dismiss')
  dismissFollowUp(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.emailIntelligenceService.dismissFollowUp(user.sub, id, body?.reason);
  }

  @Get(':id')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.emailIntelligenceService.getOne(user.sub, id);
  }

  // The stored messages of this email's conversation, with what has been
  // answered — for the detail view's thread timeline.
  @Get(':id/thread')
  async thread(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const thread = await this.emailIntelligenceService.thread(user.sub, id);
    // Both sides of the conversation: what we sent back, as stored from Sent Items.
    const sent = await this.conversations.sentInConversation(user.sub, thread.conversationId ?? undefined);
    return {
      ...thread,
      sent: sent.map((m) => ({ id: m._id.toString(), subject: m.subject, to: m.toAddresses, sentAt: m.sentAt, preview: m.bodyPreview })),
    };
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: { finalDraftReply?: string }) {
    return this.emailIntelligenceService.approve(user.sub, id, body?.finalDraftReply);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.emailIntelligenceService.reject(user.sub, id, body?.reason);
  }

  // Phase 14d — the only route that actually dispatches a real email. No
  // additional safety gate here beyond the existing approved/self-scoped
  // checks in the service — the frontend's own confirmation prompt is the
  // deliberate human-in-the-loop step (see plan notes: approve and send are
  // two separate explicit actions, never combined).
  @Post(':id/send')
  async send(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const item = await this.emailIntelligenceService.send(user.sub, id);
    this.confirmFromMailbox(user.sub);
    return item;
  }

  // "Approve & send": the reply as the person left it — the AI's draft, an edited one, or one they
  // wrote themselves — approved and dispatched in one step. The button says what it does; there is
  // no second click. A failed send leaves it approved and unsent, with the reason, to be sent again.
  @Post(':id/reply')
  async reply(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: { text?: string }) {
    const item = await this.emailIntelligenceService.reply(user.sub, id, body?.text ?? '');
    this.confirmFromMailbox(user.sub);
    return item;
  }

  // Shortly after a send, read the reply back from Outlook's Sent Items so the sent message itself
  // is on record against the conversation (the email is already marked answered — this only
  // confirms it from the mailbox).
  private confirmFromMailbox(userId: string): void {
    setTimeout(() => {
      this.emailIntelligenceSyncService
        .refreshReplies(userId, { force: true })
        .catch((err) => this.logger.warn(`Post-send mailbox check failed for user ${userId}: ${(err as Error).message}`));
    }, 15_000).unref();
  }

  @Post(':id/regenerate')
  async regenerate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // CRM data may have changed since ingest — refetch a fresh correlation
    // context for this one on-demand action, same cost/effort as one poll
    // tick's per-org gather (not run in a loop here, just once).
    const context = await this.customerActivityService.gatherCorrelationContext(user.organizationId);
    // The AI reads the whole conversation so far, not just this one message.
    const item = await this.emailIntelligenceService.getOne(user.sub, id);
    const [thread, ownAddresses] = await Promise.all([
      this.conversations.threadContext(user.sub, item.conversationId, item.receivedAt, id),
      this.conversations.ownAddresses(user.sub),
    ]);
    return this.emailIntelligenceService.regenerate(user.sub, id, context, { thread, ownAddresses });
  }
}
