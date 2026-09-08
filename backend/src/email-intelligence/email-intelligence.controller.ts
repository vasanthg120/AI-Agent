import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CustomerActivityService } from '../crm/customer-activity.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailIntelligenceSyncService } from './email-intelligence-sync.service';
import { EmailIntelligenceService } from './email-intelligence.service';

// No @Roles()/RolesGuard anywhere in this controller — every authenticated
// user, self-scoped via their own JWT sub. Each item belongs to exactly one
// mailbox owner; there is no org-wide oversight view in this pass (see
// Phase 14b plan notes).
@UseGuards(JwtAuthGuard)
@Controller('email-intelligence')
export class EmailIntelligenceController {
  constructor(
    private emailIntelligenceService: EmailIntelligenceService,
    private customerActivityService: CustomerActivityService,
    private emailIntelligenceSyncService: EmailIntelligenceSyncService,
  ) {}

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

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: 'pending' | 'approved' | 'rejected',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.emailIntelligenceService.list(user.sub, status, from, to);
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
  // send, gated behind AI_FOLLOWUP_ACTIONS_ENABLED (see
  // email-intelligence.service.ts's generateFollowUpDraft).
  @Post('follow-ups/:id/draft')
  generateFollowUpDraft(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
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

  @Get(':id')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.emailIntelligenceService.getOne(user.sub, id);
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
  send(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.emailIntelligenceService.send(user.sub, id);
  }

  @Post(':id/regenerate')
  async regenerate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // CRM data may have changed since ingest — refetch a fresh correlation
    // context for this one on-demand action, same cost/effort as one poll
    // tick's per-org gather (not run in a loop here, just once).
    const context = await this.customerActivityService.gatherCorrelationContext(user.organizationId);
    return this.emailIntelligenceService.regenerate(user.sub, id, context);
  }
}
