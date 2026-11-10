import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { FinanceOverviewQueryDto } from './dto/finance-overview-query.dto';
import { FinanceDashboardService } from './finance-dashboard.service';
import { FinanceSummaryService } from './finance-summary.service';
import { Permission } from '../common/permissions/permission.decorator';

// `regenerate: true` deliberately bypasses generateSummary's own daily
// cache to force a fresh, billed LLM call — tighter than the app-wide
// default (app.module.ts) so that bypass isn't only bounded by the generic
// per-IP ceiling.
const GENERATE_SUMMARY_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Permission('finance')
@Controller('finance/dashboard')
export class FinanceDashboardController {
  constructor(
    private financeDashboardService: FinanceDashboardService,
    private financeSummaryService: FinanceSummaryService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: JwtPayload, @Query() query: FinanceOverviewQueryDto) {
    const [overview, aiGeneratedSummary] = await Promise.all([
      this.financeDashboardService.getOverview(user.organizationId, query),
      this.financeSummaryService.getCachedSummary(user.organizationId, new Date().toISOString().slice(0, 10)),
    ]);
    // Named distinctly from overview's own `summary` field (the aggregate
    // stats block) — spreading overview first then adding a same-named key
    // would silently clobber it.
    return { ...overview, aiGeneratedSummary };
  }

  @Post('generate-summary')
  @Throttle(GENERATE_SUMMARY_THROTTLE)
  @Permission('finance', 'view')
  generateSummary(@CurrentUser() user: JwtPayload, @Body() body: { regenerate?: boolean }) {
    return this.financeSummaryService.generateSummary(user, body?.regenerate ?? false);
  }
}
