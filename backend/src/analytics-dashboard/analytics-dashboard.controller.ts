import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AnalyticsDashboardService } from './analytics-dashboard.service';
import { ScopeInfo } from './analytics-dashboard.types';
import { GetAnalyticsOverviewQueryDto } from './dto/get-analytics-overview-query.dto';
import { GetPipelineByMonthQueryDto } from './dto/get-pipeline-by-month-query.dto';

// One endpoint, internal role branching — the composite response shape is
// identical across owner/manager/consultant (only the values narrow), a
// stronger case for collapsing than home-dashboard/crm-dashboard's existing
// three-separate-routes precedent (their response shapes genuinely differ
// per role). Goes one step further than customer-activity.controller.ts's
// owner/admin/manager-collapsed-but-consultant-separate precedent.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('analytics-dashboard')
export class AnalyticsDashboardController {
  constructor(private analyticsDashboardService: AnalyticsDashboardService) {}

  @Get('overview')
  // agent_user added for Agent Activity's team-wide view — self-scoped only
  // (see the else branch below), same as manager/consultant; they were never
  // given org/store override and still aren't.
  @Roles('owner', 'admin', 'manager', 'consultant', 'agent_user')
  overview(@CurrentUser() user: JwtPayload, @Query() query: GetAnalyticsOverviewQueryDto) {
    return this.analyticsDashboardService.getOverview(user, this.scopeOf(user, query), query.dateFrom, query.dateTo, query.includeAllUsers);
  }

  // The open pipeline of every month at once — whose pipeline is decided exactly as for the overview.
  @Get('pipeline-by-month')
  @Roles('owner', 'admin', 'manager', 'consultant', 'agent_user')
  pipelineByMonth(@CurrentUser() user: JwtPayload, @Query() query: GetPipelineByMonthQueryDto) {
    return this.analyticsDashboardService.getPipelineByMonth(user, this.scopeOf(user, query));
  }

  /** Whose data the caller sees: the whole organization or a chosen store/user for an owner or admin, their own store for a manager, themselves for anyone else. */
  private scopeOf(user: JwtPayload, query: { storeId?: string; userId?: string }): ScopeInfo {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (canOverride) {
      // Agent Activity's drill-down: view one specific user's data. Takes
      // priority over storeId (a userId request is always more specific)
      // — both are still admin/owner-only, never trusted from anyone else.
      if (query.userId) return { level: 'user', userId: query.userId };
      return query.storeId ? { level: 'store', storeId: query.storeId } : { level: 'org' };
    }
    if (user.roles.includes('manager')) {
      if (!user.storeId) throw new BadRequestException('No store assigned to this account');
      return { level: 'store', storeId: user.storeId };
    }
    return { level: 'user', userId: user.sub };
  }
}
