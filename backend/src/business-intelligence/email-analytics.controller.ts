import { Controller, Get, NotFoundException, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { resolveBiDateRange, scopeBiFilters } from './bi-filter.util';
import { BiFilterQueryDto } from './dto/bi-filter-query.dto';
import { BiEmailsByEmployeeQueryDto } from './dto/bi-emails-by-employee-query.dto';
import { ListBiEmailsQueryDto } from './dto/list-bi-emails-query.dto';
import { ExportBiEmailsQueryDto } from './dto/export-bi-emails-query.dto';
import { EmailAnalyticsExportService } from './email-analytics-export.service';

const EXPORT_ROW_CAP = 5000;

// Route order matters: 'summary'/'by-employee'/'emails'/'export' are static
// segments and must be registered before 'emails/:id', same rule
// deals.controller.ts's own comment documents.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('business-intelligence/email-analytics')
export class EmailAnalyticsController {
  constructor(
    private emailIntelligenceService: EmailIntelligenceService,
    private usersService: UsersService,
    private exportService: EmailAnalyticsExportService,
  ) {}

  // Org-wide totals — deliberately delegates to the exact same
  // getActivityStats() the already-trusted Analytics Dashboard email widget
  // uses, so this KPI card can never disagree with that one over the same
  // range/scope (Phase 2's own verification requirement).
  @Get('summary')
  @Roles('owner', 'admin', 'manager', 'consultant')
  summary(@CurrentUser() user: JwtPayload, @Query() query: BiFilterQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    const storeConstraint = scoped.storeId?.length === 1 ? scoped.storeId[0] : undefined;
    const personalConstraint = scoped.employeeId?.length === 1 ? scoped.employeeId[0] : undefined;
    return this.emailIntelligenceService.getActivityStats(user.organizationId, start, end, storeConstraint, personalConstraint);
  }

  @Get('by-employee')
  @Roles('owner', 'admin', 'manager', 'consultant')
  byEmployee(@CurrentUser() user: JwtPayload, @Query() query: BiEmailsByEmployeeQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    return this.emailIntelligenceService.getEmailAnalyticsByEmployee(user.organizationId, query.kind, start, end, scoped);
  }

  @Get('emails')
  @Roles('owner', 'admin', 'manager', 'consultant')
  emails(@CurrentUser() user: JwtPayload, @Query() query: ListBiEmailsQueryDto) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    return this.emailIntelligenceService.listEmailsFiltered(
      user.organizationId,
      query.kind,
      start,
      end,
      { ...scoped, intent: query.intent },
      query.page ?? 1,
      query.pageSize ?? 25,
    );
  }

  @Get('export')
  @Roles('owner', 'admin', 'manager')
  async export(@CurrentUser() user: JwtPayload, @Query() query: ExportBiEmailsQueryDto, @Res() res: Response) {
    const scoped = scopeBiFilters(user, query);
    const { start, end } = resolveBiDateRange(scoped);
    const [{ items, total }, users] = await Promise.all([
      this.emailIntelligenceService.listEmailsFiltered(
        user.organizationId,
        query.kind,
        start,
        end,
        { ...scoped, intent: query.intent },
        1,
        EXPORT_ROW_CAP,
      ),
      this.usersService.findAll(user.organizationId),
    ]);
    const employeeNameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    const rows = this.exportService.buildRows(items, employeeNameById);

    if (total > EXPORT_ROW_CAP) res.set('X-Export-Truncated', 'true');
    const filenameDate = query.dateFrom ?? 'current-month';

    if (query.format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="emails-${filenameDate}.csv"` });
      res.send(this.exportService.toCsv(rows));
      return;
    }
    if (query.format === 'xlsx') {
      const buffer = await this.exportService.toExcel(rows);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="emails-${filenameDate}.xlsx"`,
      });
      res.send(buffer);
      return;
    }
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="emails-${filenameDate}.pdf"` });
    const doc = new PDFDocument();
    doc.pipe(res);
    this.exportService.writePdf(doc, rows, query);
    doc.end();
  }

  @Get('emails/:id')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const item = await this.emailIntelligenceService.getOneForOrg(user.organizationId, id);
    await this.authorizeItemAccess(user, item.userId);
    return item;
  }

  // Full body, fetched live from Graph (never stored — see
  // EmailIntelligenceItem's bodyPreview-only comment) so "open and read"
  // shows the actual email, not just the ~255-char preview snippet. Same
  // RBAC as getOne above — this only ever surfaces content for an email the
  // caller was already allowed to see the summary of.
  @Get('emails/:id/body')
  @Roles('owner', 'admin', 'manager', 'consultant')
  async getBody(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const item = await this.emailIntelligenceService.getOneForOrg(user.organizationId, id);
    await this.authorizeItemAccess(user, item.userId);
    return this.emailIntelligenceService.getFullBody(item);
  }

  // Consultant self-scope, server-enforced — never trust the URL param
  // alone at this RBAC tier (same principle as every other BI endpoint's
  // scopeBiFilters, applied here post-fetch since getOneForOrg/getFullBody
  // are single-record lookups, not filtered lists). Shared by getOne and
  // getBody so the two can never drift apart on who's allowed to see what.
  private async authorizeItemAccess(user: JwtPayload, itemOwnerUserId: string): Promise<void> {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (canOverride) return;
    if (user.roles.includes('consultant') && itemOwnerUserId !== user.sub) {
      throw new NotFoundException('Email intelligence item not found');
    }
    if (user.roles.includes('manager')) {
      const owner = await this.usersService.findById(itemOwnerUserId);
      if (!owner || owner.storeId !== user.storeId) throw new NotFoundException('Email intelligence item not found');
    }
  }
}
