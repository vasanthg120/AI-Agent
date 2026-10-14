import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { GetSalesReportQueryDto } from './dto/get-sales-report-query.dto';
import { GetGrossMarginReportQueryDto } from './dto/get-gross-margin-report-query.dto';
import { UpdateReportingSettingsDto } from './dto/update-reporting-settings.dto';
import { SalesReportService } from './sales-report.service';
import { GrossMarginReportService } from './gross-margin-report.service';
import { ReportingSettingsService } from './reporting-settings.service';

// Same CRUD-tier RBAC as the Royalty report (owner/admin/manager, manager
// store-scoped) — these are read-only aggregate reports over the same
// underlying CRM data.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reporting')
export class ReportingController {
  constructor(
    private salesReportService: SalesReportService,
    private grossMarginReportService: GrossMarginReportService,
    private settingsService: ReportingSettingsService,
    private usersService: UsersService,
  ) {}

  @Get('sales')
  @Roles('owner', 'admin', 'manager')
  sales(@CurrentUser() user: JwtPayload, @Query() query: GetSalesReportQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.salesReportService.generate(user.organizationId, query.dateFrom, query.dateTo, query.groupBy, storeConstraint);
  }

  @Get('gross-margin')
  @Roles('owner', 'admin', 'manager')
  grossMargin(@CurrentUser() user: JwtPayload, @Query() query: GetGrossMarginReportQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.grossMarginReportService.generate(user.organizationId, query.dateFrom, query.dateTo, query.groupBy, storeConstraint);
  }

  // What the organization tells the reports once (today: its gross margin percentage).
  @Get('settings')
  @Roles('owner', 'admin', 'manager')
  settings(@CurrentUser() user: JwtPayload) {
    return this.settingsService.get(user.organizationId);
  }

  // Org-wide financial configuration: the same tighter tier as the royalty rule itself.
  @Put('settings')
  @Roles('owner', 'admin')
  async updateSettings(@CurrentUser() user: JwtPayload, @Body() dto: UpdateReportingSettingsDto) {
    const who = await this.usersService.findById(user.sub);
    return this.settingsService.setGrossMarginPct(user.organizationId, dto.grossMarginPct ?? null, { id: user.sub, name: who?.name || user.email });
  }
}
