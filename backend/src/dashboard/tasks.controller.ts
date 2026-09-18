import { Body, Controller, Get, Param, Patch, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
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
  calendar(@Query('month') month: string, @Query('mine') mine: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.tasksService.calendarSummary(month, user, mine === undefined ? undefined : mine === 'true');
  }

  // Registered before ':id' for the same reason 'calendar'/'export' are —
  // distinct static segment, no route-matching ambiguity with Patch(':id').
  @Get('recommendations')
  recommendations(@CurrentUser() user: JwtPayload) {
    return this.tasksService.getRecommendations(user);
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
    const doc = new PDFDocument();
    doc.pipe(res);
    this.tasksExportService.writePdf(doc, tasks, query);
    doc.end();
  }

  @Patch(':id')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTaskStatusDto, @CurrentUser() user: JwtPayload) {
    return this.tasksService.updateStatus(id, dto.status, user);
  }
}
