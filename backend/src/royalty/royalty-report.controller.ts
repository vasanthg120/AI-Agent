import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { createBrandedDocument, finalizePagedDocument } from '../common/pdf/branded-pdf';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GetRoyaltyReportQueryDto } from './dto/get-royalty-report-query.dto';
import { ExportRoyaltyReportQueryDto } from './dto/export-royalty-report-query.dto';
import { RoyaltyReportService } from './royalty-report.service';
import { RoyaltyReportExportService } from './royalty-report-export.service';

// Same CRUD-tier RBAC as InvoicesController (owner/admin/manager,
// manager store-scoped) — a generated report is a read operation over the
// same data that controller already exposes, not the tighter tier
// RoyaltyRulesController uses for editing the actual rule.
//
// Route order matters: 'export' is a static segment, registered as its own
// route (not a child of the bare GET), so it never collides with the
// no-path generate() handler — same rule deals.controller.ts documents for
// its own 'query'/'export' segments ahead of ':id'.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('royalty/report')
export class RoyaltyReportController {
  constructor(
    private royaltyReportService: RoyaltyReportService,
    private royaltyReportExportService: RoyaltyReportExportService,
  ) {}

  @Get()
  @Roles('owner', 'admin', 'manager')
  generate(@CurrentUser() user: JwtPayload, @Query() query: GetRoyaltyReportQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.royaltyReportService.generateReport(
      user.organizationId,
      query.dateFrom,
      query.dateTo,
      storeConstraint,
      query.groupBy,
    );
  }

  @Get('export')
  @Roles('owner', 'admin', 'manager')
  async export(@CurrentUser() user: JwtPayload, @Query() query: ExportRoyaltyReportQueryDto, @Res() res: Response) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    const report = await this.royaltyReportService.generateReport(user.organizationId, query.dateFrom, query.dateTo, storeConstraint);
    const rows = this.royaltyReportExportService.buildRows(report);
    const filenameSuffix = `${query.dateFrom}_to_${query.dateTo}`;

    if (query.format === 'csv') {
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="royalty-report-${filenameSuffix}.csv"`,
      });
      res.send(this.royaltyReportExportService.toCsv(rows));
      return;
    }

    if (query.format === 'xlsx') {
      const buffer = await this.royaltyReportExportService.toExcel(rows, report);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="royalty-report-${filenameSuffix}.xlsx"`,
      });
      res.send(buffer);
      return;
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="royalty-report-${filenameSuffix}.pdf"`,
    });
    const doc = createBrandedDocument();
    doc.pipe(res);
    this.royaltyReportExportService.writePdf(doc, rows, { dateFrom: query.dateFrom, dateTo: query.dateTo }, report);
    finalizePagedDocument(doc);
  }
}
