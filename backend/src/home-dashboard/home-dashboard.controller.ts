import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { HomeDashboardService } from './home-dashboard.service';
import { Permission } from '../common/permissions/permission.decorator';

// Same guard/role shape as the sibling BusinessDashboardController.
@UseGuards(JwtAuthGuard)
@Permission('dashboard')
@Controller('home-dashboard')
export class HomeDashboardController {
  constructor(private homeDashboardService: HomeDashboardService) {}

  @Get('owner')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  ownerHome(@CurrentUser() user: JwtPayload) {
    return this.homeDashboardService.getOwnerHome(user);
  }

  @Get('manager')
  @UseGuards(RolesGuard)
  @Roles('manager', 'admin', 'owner')
  managerHome(@CurrentUser() user: JwtPayload, @Query('storeId') storeId?: string) {
    return this.homeDashboardService.getManagerHome(user, storeId);
  }

  @Get('consultant')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  consultantHome(@CurrentUser() user: JwtPayload) {
    return this.homeDashboardService.getConsultantHome(user);
  }
}
