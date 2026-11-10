import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateNotificationPolicyDto } from './dto/update-notification-policy.dto';
import { OrganizationsService } from './organizations.service';
import { Permission, PermissionExempt } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@Controller('organizations')
export class OrganizationsController {
  constructor(private organizationsService: OrganizationsService) {}

  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.organizationsService.findOrgById(user.organizationId);
  }

  @Get('stores')
  stores(@CurrentUser() user: JwtPayload) {
    return this.organizationsService.listStores(user.organizationId);
  }

  // Additional stores beyond the one auto-created at signup — an
  // owner/admin action, same sensitivity class as the other business-wide
  // mutations (store-settings, integrations, agent-roles).
  @Post('stores')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('settings', 'manage')
  createStore(@CurrentUser() user: JwtPayload, @Body() dto: CreateStoreDto) {
    return this.organizationsService.createStore(user.organizationId, dto);
  }

  // Any org member can read the policy (so the Notifications settings page
  // can grey out a channel with "disabled by your organization" instead of
  // silently no-op'ing a save) — only owner/admin can change it, same
  // sensitivity class as the other business-wide mutations above.
  @Get('notification-policy')
  getNotificationPolicy(@CurrentUser() user: JwtPayload) {
    return this.organizationsService.getNotificationPolicy(user.organizationId);
  }

  @Put('notification-policy')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  @Permission('settings', 'manage')
  updateNotificationPolicy(@CurrentUser() user: JwtPayload, @Body() dto: UpdateNotificationPolicyDto) {
    return this.organizationsService.updateNotificationPolicy(user.organizationId, dto);
  }
}
