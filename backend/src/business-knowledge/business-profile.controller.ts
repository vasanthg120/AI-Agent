import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { BusinessProfileService } from './business-profile.service';
import { UpsertBusinessProfileDto } from './dto/upsert-business-profile.dto';
import { Feature } from '../common/app-features';

// Reads are CRM-dashboard-tier (owner/admin/manager) — ordinary operational
// context, not Finance-tier sensitive. Mutation is tighter (owner/admin
// only, via the method-level @Roles() override below) since a bad edit here
// becomes what every chat persona tells every employee, company-wide.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('business_knowledge')
@Controller('business-knowledge/profile')
export class BusinessProfileController {
  constructor(private profileService: BusinessProfileService) {}

  @Get()
  get(@CurrentUser() user: JwtPayload) {
    return this.profileService.getOrDefault(user.organizationId);
  }

  @Put()
  @Roles('owner', 'admin')
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertBusinessProfileDto) {
    return this.profileService.upsert(user, dto);
  }
}
