import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { EmailIntelligenceService } from './email-intelligence.service';
import { Permission } from '../common/permissions/permission.decorator';

// Phase 14c — deliberately contributes routes under the same
// 'crm/customer-activity' prefix CustomerActivityController (in CrmModule)
// already owns, from a different module/controller class. This lives in
// EmailIntelligenceModule (not CrmModule) because it needs both CRM data
// (via CustomerActivityService, already exported from CrmModule) and this
// module's own EmailIntelligenceItem history — CrmModule depending back on
// this module would create a cycle. Same RBAC/store-scoping pattern as the
// sibling relationships/personal-relationships routes.
@UseGuards(JwtAuthGuard)
@Permission('customers')
@Controller('crm/customer-activity')
export class CustomerTimelineController {
  constructor(private emailIntelligenceService: EmailIntelligenceService) {}

  @Get('timeline/:businessKey')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  timeline(@CurrentUser() user: JwtPayload, @Param('businessKey') businessKey: string, @Query('storeId') storeIdOverride?: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? storeIdOverride : user.storeId;
    return this.emailIntelligenceService.getCustomerTimeline(user, businessKey, storeConstraint);
  }

  @Get('personal-timeline/:businessKey')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  personalTimeline(@CurrentUser() user: JwtPayload, @Param('businessKey') businessKey: string) {
    return this.emailIntelligenceService.getPersonalCustomerTimeline(user, businessKey);
  }
}
