import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { BusinessDashboardService } from './business-dashboard.service';
import { BusinessDashboardQueryDto } from './dto/business-dashboard-query.dto';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('dashboard')
@Controller('crm/dashboard')
export class BusinessDashboardController {
  constructor(private businessDashboardService: BusinessDashboardService) {}

  @Get('owner')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  ownerOverview(@CurrentUser() user: JwtPayload, @Query() query: BusinessDashboardQueryDto) {
    return this.businessDashboardService.getOwnerOverview(user, query.period);
  }

  @Get('manager')
  @UseGuards(RolesGuard)
  @Roles('manager', 'admin', 'owner')
  managerOverview(@CurrentUser() user: JwtPayload, @Query() query: BusinessDashboardQueryDto) {
    return this.businessDashboardService.getManagerOverview(user, query.storeId, query.period);
  }

  @Get('consultant')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  consultantOverview(@CurrentUser() user: JwtPayload, @Query() query: BusinessDashboardQueryDto) {
    return this.businessDashboardService.getConsultantOverview(user, query.period);
  }
}
