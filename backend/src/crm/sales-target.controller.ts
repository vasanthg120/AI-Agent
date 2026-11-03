import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GetAchievementQueryDto } from './dto/get-achievement-query.dto';
import { UpsertSalesTargetDto } from './dto/upsert-sales-target.dto';
import { SalesAnalyticsService } from './sales-analytics.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('settings')
@Controller('sales-targets')
export class SalesTargetController {
  constructor(private salesAnalyticsService: SalesAnalyticsService) {}

  // Browsing/setting targets is an owner/admin action (same tier as
  // settings/users) — Manager/Consultant only ever see their own computed
  // achievement via their dashboard endpoints, never the raw target list.
  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  // currency: only the targets in that currency (Settings asks for the shown CRM's).
  list(@CurrentUser() user: JwtPayload, @Query('period') period?: string, @Query('currency') currency?: string) {
    return this.salesAnalyticsService.listTargets(user.organizationId, period, currency);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertSalesTargetDto) {
    return this.salesAnalyticsService.upsertTarget(user.organizationId, dto);
  }

  // Was missing this guard entirely — scope/scopeId are client-supplied, so
  // without it any authenticated caller (including a consultant) could ask
  // for `?scope=org` (whole-org revenue) or `?scope=user&scopeId=<coworker>`
  // (a specific colleague's personal figures). Same admin-only tier as list/
  // upsert above — Manager/Consultant still only see their own computed
  // achievement via their dashboard endpoints, never this raw route.
  @Get('achievement')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('analytics', 'view')
  achievement(@CurrentUser() user: JwtPayload, @Query() query: GetAchievementQueryDto) {
    return this.salesAnalyticsService.getAchievement(user.organizationId, query.scope, query.scopeId, query.period);
  }
}
