import { Body, Controller, Get, Param, Patch, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { createBrandedDocument, finalizePagedDocument } from '../common/pdf/branded-pdf';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ExportTasksQueryDto } from './dto/export-tasks-query.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TasksExportService } from './tasks-export.service';
import { TasksService } from './tasks.service';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(
    private tasksService: TasksService,
    private tasksExportService: TasksExportService,
  ) {}

  @Get()
  list(@Query() query: ListTasksQueryDto, @CurrentUser() user: JwtPayload) {
    return this.tasksService.list(query, user);
  }

  @Get('calendar')
  calendar(
    @Query('month') month: string,
    @Query('mine') mine: string | undefined,
    @Query('reportType') reportType: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.tasksService.calendarSummary(
      month,
      user,
      mine === undefined ? undefined : mine === 'true',
      reportType === 'morning' || reportType === 'eod' ? reportType : undefined,
    );
  }

  // Same static-segment-before-':id' reasoning as 'calendar'/'export' above.
  // date is optional (defaults to today, see getEodSummary) — the EOD page's
  // Calendar view passes an explicit past date to look up that day's report.
  @Get('eod')
  eodSummary(@Query('date') date: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.tasksService.getEodSummary(user, date);
  }

  // Registered before ':id' isn't needed here — 'export'/'calendar' are
  // distinct static segments from the Patch(':id') route below, which is a
  // different HTTP method, so there's no route-matching ambiguity.
  @Get('export')
  async export(@Query() query: ExportTasksQueryDto, @CurrentUser() user: JwtPayload, @Res() res: Response) {
    // Same RBAC-scoped query as GET /tasks — no second scoping implementation
    // to independently get right for the export path.
    const { tasks } = await this.tasksService.list(query, user);
    const filenameDate = query.dateFrom ?? 'today';

    if (query.format === 'csv') {
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tasks-${filenameDate}.csv"`,
      });
      res.send(this.tasksExportService.toCsv(tasks));
      return;
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="tasks-${filenameDate}.pdf"`,
    });
    const doc = createBrandedDocument();
    doc.pipe(res);
    this.tasksExportService.writePdf(doc, tasks, query);
    finalizePagedDocument(doc);
  }

  // A real EOD report export — previously "downloading the EOD report" hit
  // the same /tasks/export route above, scoped to one day, which only ever
  // re-exported that day's task list, never the narrative/email/CRM
  // breakdown the EOD page itself shows. Mirrors /tasks/export's csv/pdf
  // branching exactly, just backed by getEodSummary instead of list().
  @Get('eod/export')
  async eodExport(
    @Query('date') date: string | undefined,
    @Query('format') format: 'csv' | 'pdf' | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const summary = await this.tasksService.getEodSummary(user, date);
    const filenameDate = summary.date;

    if (format === 'csv') {
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="eod-${filenameDate}.csv"`,
      });
      res.send(this.tasksExportService.toEodCsv(summary));
      return;
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="eod-${filenameDate}.pdf"`,
    });
    const doc = createBrandedDocument();
    doc.pipe(res);
    this.tasksExportService.writeEodPdf(doc, summary);
    finalizePagedDocument(doc);
  }

  @Patch(':id')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTaskStatusDto, @CurrentUser() user: JwtPayload) {
    return this.tasksService.updateStatus(id, dto.status, user);
  }
}
