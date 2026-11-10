import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GetOverviewQueryDto } from './dto/get-overview-query.dto';
import { GetTrendQueryDto } from './dto/get-trend-query.dto';
import { DashboardService } from './dashboard.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('overview')
  overview(@Query() query: GetOverviewQueryDto, @CurrentUser() user: JwtPayload) {
    return this.dashboardService.getOverview(user, query.agentId);
  }

  @Get('trend')
  trend(@Query() query: GetTrendQueryDto, @CurrentUser() user: JwtPayload) {
    return this.dashboardService.getTrend(query.agentId, query.days, user);
  }
}
