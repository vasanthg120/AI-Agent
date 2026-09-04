import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ExcludeSlaRecordDto } from './dto/exclude-sla-record.dto';
import { UpdateBusinessHoursDto } from './dto/update-business-hours.dto';
import { UpdateSlaPolicyDto } from './dto/update-sla-policy.dto';
import { UpsertEscalationRuleDto } from './dto/upsert-escalation-rule.dto';
import { UpsertSlaPolicyDto } from './dto/upsert-sla-policy.dto';
import { EmailSlaEscalationService } from './email-sla-escalation.service';
import { EmailSlaPolicyService } from './email-sla-policy.service';
import { EmailSlaStatus } from './schemas/email-sla-record.schema';
import { EmailSlaService } from './email-sla.service';

// Same org-scoped-from-JWT, JwtAuthGuard-only pattern as the rest of the
// email-intelligence-adjacent surface — every route resolves organizationId
// from the caller's own token, never a client-supplied value, so a request
// can never read/write another org's SLA data. Policy/escalation-rule
// mutation is owner/admin/manager only (same tier as Email Intelligence's
// own activity-stats routes); record reads/actions are open to every
// authenticated user in the org, matching this module's "isolated, additive"
// posture — it doesn't invent a new permission tier.
@UseGuards(JwtAuthGuard)
@Controller('email-sla')
export class EmailSlaController {
  constructor(
    private slaService: EmailSlaService,
    private policyService: EmailSlaPolicyService,
    private escalationService: EmailSlaEscalationService,
  ) {}

  @Get('records')
  listRecords(@CurrentUser() user: JwtPayload, @Query('status') status?: EmailSlaStatus, @Query('assignedUserId') assignedUserId?: string) {
    return this.slaService.listRecords(user.organizationId, { status, assignedUserId });
  }

  @Get('records/:id')
  getRecord(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.slaService.getRecord(user.organizationId, id);
  }

  @Post('records/:id/resolve')
  resolveRecord(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.slaService.resolveRecord(user.organizationId, id);
  }

  @Post('records/:id/exclude')
  excludeRecord(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ExcludeSlaRecordDto) {
    return this.slaService.excludeRecord(user.organizationId, id, dto.reason);
  }

  @Get('dashboard')
  dashboard(@CurrentUser() user: JwtPayload) {
    return this.slaService.getDashboard(user.organizationId);
  }

  @Get('events')
  listEvents(@CurrentUser() user: JwtPayload, @Query('recordId') recordId?: string) {
    return this.slaService.listEvents(user.organizationId, recordId);
  }

  @Get('policies')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  listPolicies(@CurrentUser() user: JwtPayload) {
    return this.policyService.listPolicies(user.organizationId);
  }

  @Post('policies')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  upsertPolicy(@CurrentUser() user: JwtPayload, @Body() dto: UpsertSlaPolicyDto) {
    return this.policyService.upsertPolicy(user.organizationId, dto.priority, dto);
  }

  @Patch('policies/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  updatePolicy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateSlaPolicyDto) {
    return this.policyService.updatePolicy(user.organizationId, id, dto);
  }

  @Get('business-hours')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  getBusinessHours(@CurrentUser() user: JwtPayload) {
    return this.policyService.getBusinessHoursConfig(user.organizationId);
  }

  @Post('business-hours')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  upsertBusinessHours(@CurrentUser() user: JwtPayload, @Body() dto: UpdateBusinessHoursDto) {
    return this.policyService.upsertBusinessHoursConfig(user.organizationId, dto);
  }

  // Returns the org's configured escalation rules — the audit trail of
  // escalations that actually fired lives at GET /email-sla/events instead
  // (type: 'escalated'), so this route name isn't ambiguous with that one.
  @Get('escalations')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  listEscalationRules(@CurrentUser() user: JwtPayload) {
    return this.escalationService.listRules(user.organizationId);
  }

  @Post('escalations')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  upsertEscalationRule(@CurrentUser() user: JwtPayload, @Body() dto: UpsertEscalationRuleDto) {
    return this.escalationService.upsertRule(user.organizationId, dto);
  }
}
