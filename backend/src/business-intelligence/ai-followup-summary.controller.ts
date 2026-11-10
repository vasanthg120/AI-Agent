import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { AiFollowupSummaryService } from './ai-followup-summary.service';
import { Permission } from '../common/permissions/permission.decorator';

// `regenerate: true` deliberately bypasses generateSummary's own daily
// cache — same throttle shape as finance-dashboard.controller.ts's own
// generate-summary route.
const GENERATE_SUMMARY_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@UseGuards(JwtAuthGuard, RolesGuard)
@Permission('analytics')
@Controller('business-intelligence/ai-followup-summary')
export class AiFollowupSummaryController {
  constructor(
    private aiFollowupSummaryService: AiFollowupSummaryService,
    private emailIntelligenceService: EmailIntelligenceService,
  ) {}

  // The raw follow-up list is always real and live, for every role tier —
  // AI adds prioritization/narrative on top, never replaces it (see
  // listFollowUpsForOrg's own comment). Consultant gets their own
  // self-scoped reminders only (existing listFollowUps) and never the
  // org-wide AI summary — see the generate() route's own comment for why.
  @Get()
  @Roles('owner', 'admin', 'manager', 'consultant')
  async overview(@CurrentUser() user: JwtPayload) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (!canOverride && user.roles.includes('consultant')) {
      const followUpReminders = await this.emailIntelligenceService.listFollowUps(user.sub);
      return { followUpReminders, aiGeneratedSummary: null };
    }

    const storeConstraint = !canOverride && user.roles.includes('manager') ? user.storeId : undefined;
    const [followUpReminders, aiGeneratedSummary] = await Promise.all([
      this.emailIntelligenceService.listFollowUpsForOrg(user.organizationId, storeConstraint ? { storeId: [storeConstraint] } : {}),
      this.aiFollowupSummaryService.getCachedSummary(user.organizationId, new Date().toISOString().slice(0, 10)),
    ]);
    return { followUpReminders, aiGeneratedSummary };
  }

  // Deliberately tighter than this controller's own read tier — the
  // generated summary aggregates every employee's overdue items and
  // high-risk customers org-wide (AiFollowupSummaryService's cache has no
  // filter dimension, same precedent as finance-summary.service.ts), which
  // is more than a consultant's own self-scoped view should expose.
  @Post('generate')
  @Roles('owner', 'admin', 'manager')
  @Throttle(GENERATE_SUMMARY_THROTTLE)
  @Permission('analytics', 'view')
  generate(@CurrentUser() user: JwtPayload, @Body() body: { regenerate?: boolean }) {
    return this.aiFollowupSummaryService.generateSummary(user, body?.regenerate ?? false);
  }
}
