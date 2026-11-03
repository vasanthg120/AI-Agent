import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditService } from './audit.service';
import { PermissionExempt } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@PermissionExempt('not_grantable')
@Controller('audit-logs')
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.auditService.list(user.organizationId);
  }
}
