import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { DateQueryDto, HistoryQueryDto, LifecycleActionDto } from './dto/work.dto';
import { EodDeliveryService } from './eod-delivery.service';
import { EodReport, EodReportDocument } from './schemas/eod-report.schema';
import { WorkTaskEvent, WorkTaskEventDocument } from './schemas/work-task-event.schema';
import { WorkTask, WorkTaskDocument } from './schemas/work-task.schema';
import { TaskLifecycleService } from './task-lifecycle.service';
import { LIFECYCLE_ACTIONS, LifecycleAction } from './task-lifecycle';
import { TaskQueryService, toTaskView } from './task-query.service';
import { TaskSyncService } from './task-sync.service';
import { TeamDashboardService } from './team-dashboard.service';
import { WorkAccessService } from './work-access.service';

// What every signed-in person uses: their own To-Do, activity, EOD history, and —
// for managers and admins — the people they oversee. Data is always scoped to the
// caller's organization, and to people the caller may see (WorkAccessService).
@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@Controller('work-automation')
export class WorkController {
  constructor(
    private sync: TaskSyncService,
    private query: TaskQueryService,
    private lifecycle: TaskLifecycleService,
    private access: WorkAccessService,
    private team: TeamDashboardService,
    private delivery: EodDeliveryService,
    @InjectModel(WorkTask.name) private tasks: Model<WorkTaskDocument>,
    @InjectModel(WorkTaskEvent.name) private events: Model<WorkTaskEventDocument>,
    @InjectModel(EodReport.name) private reports: Model<EodReportDocument>,
  ) {}

  /** Called when the person opens Haive: refreshes their assigned work from every connected source (skipped when synced recently). */
  @Post('sync/me')
  syncMe(@CurrentUser() user: JwtPayload) {
    return this.sync.syncUser(user.organizationId, user.sub, 'login');
  }

  /** A "refresh now" button: bypasses the recent-sync throttle for the caller's own data only. */
  @Post('sync/me/force')
  syncMeNow(@CurrentUser() user: JwtPayload) {
    return this.sync.syncUser(user.organizationId, user.sub, 'manual', { force: true });
  }

  @Get('me/today')
  myDay(@CurrentUser() user: JwtPayload, @Query() q: DateQueryDto) {
    return this.query.dayView(user.organizationId, user.sub, { date: q.date });
  }

  @Get('me/activity')
  myActivity(@CurrentUser() user: JwtPayload, @Query() q: DateQueryDto) {
    return this.query.activity(user.organizationId, user.sub, { date: q.date });
  }

  @Get('users/:userId/today')
  async userDay(@CurrentUser() user: JwtPayload, @Param('userId') userId: string, @Query() q: DateQueryDto) {
    await this.assertMayView(user, userId);
    return this.query.dayView(user.organizationId, userId, { date: q.date });
  }

  @Get('users/:userId/activity')
  async userActivity(@CurrentUser() user: JwtPayload, @Param('userId') userId: string, @Query() q: DateQueryDto) {
    await this.assertMayView(user, userId);
    return this.query.activity(user.organizationId, userId, { date: q.date });
  }

  /** start | block | unblock | request_verification (assignee) and verify | reject_verification | reopen (manager/admin). */
  @Post('tasks/:id/:action')
  async act(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('action') action: string, @Body() dto: LifecycleActionDto) {
    if (!(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) throw new BadRequestException('Unknown action.');
    const task = await this.lifecycle.act(user, id, action as LifecycleAction, dto.note);
    return toTaskView(task, new Date());
  }

  /** The activity history of one task (who changed what, with evidence). */
  @Get('tasks/:id/history')
  async history(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Task not found.');
    const task = await this.tasks.findOne({ _id: id, organizationId: user.organizationId }).exec();
    if (!task) throw new NotFoundException('Task not found.');
    await this.assertMayView(user, task.assignedTo);
    const events = await this.events.find({ organizationId: user.organizationId, taskId: id }).sort({ at: 1 }).limit(200).exec();
    return { task: toTaskView(task, new Date()), events: events.map((e) => ({ at: e.at, type: e.type, actor: e.actor, from: e.from, to: e.to, note: e.note })) };
  }

  @Get('eod/mine')
  async myReports(@CurrentUser() user: JwtPayload, @Query() q: HistoryQueryDto) {
    const rows = await this.reports.find({ organizationId: user.organizationId, userId: user.sub }).sort({ date: -1 }).limit(q.limit ?? 30).exec();
    return rows.map(listItem);
  }

  /** Reports of the people the caller oversees (manager's "Daily EOD reports"). */
  @Get('eod/team')
  async teamReports(@CurrentUser() user: JwtPayload, @Query() q: DateQueryDto) {
    const ids = (await this.access.visibleUserIds(user)).filter((id) => id !== user.sub);
    if (ids.length === 0) return [];
    const filter: Record<string, unknown> = { organizationId: user.organizationId, userId: { $in: ids } };
    if (q.date) filter.date = q.date;
    const rows = await this.reports.find(filter).sort({ date: -1 }).limit(200).exec();
    return rows.map(listItem);
  }

  @Get('eod/:id')
  async report(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const report = await this.loadReport(user, id);
    return { ...listItem(report), sections: report.sections, summary: report.summary, dataGaps: report.dataGaps };
  }

  @Get('eod/:id/deliveries')
  async deliveries(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const report = await this.loadReport(user, id);
    const rows = await this.delivery.list(user.organizationId, report._id.toString());
    return rows.map((d) => ({ role: d.role, recipientEmail: d.recipientEmail, status: d.status, channel: d.channel, attempts: d.attempts, sentAt: d.sentAt, lastError: d.lastError, skippedReason: d.skippedReason, nextAttemptAt: d.nextAttemptAt }));
  }

  /** Manager / admin dashboard: team task state and EOD report status. */
  @Get('team')
  teamDashboard(@CurrentUser() user: JwtPayload, @Query() q: DateQueryDto) {
    return this.team.dashboard(user, { date: q.date });
  }

  private async assertMayView(user: JwtPayload, targetUserId: string) {
    if (!(await this.access.canView(user, targetUserId))) throw new ForbiddenException('You can only see your own work and your team’s.');
  }

  private async loadReport(user: JwtPayload, id: string): Promise<EodReportDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Report not found.');
    const report = await this.reports.findOne({ _id: id, organizationId: user.organizationId }).exec();
    if (!report) throw new NotFoundException('Report not found.');
    await this.assertMayView(user, report.userId);
    return report;
  }
}

function listItem(r: EodReportDocument) {
  return {
    id: r._id.toString(),
    userId: r.userId,
    employeeName: r.employeeName,
    date: r.date,
    timezone: r.timezone,
    status: r.status,
    generatedAt: r.generatedAt,
    wasMissed: r.wasMissed,
    summarySource: r.summarySource,
    counts: r.sections?.counts,
  };
}
