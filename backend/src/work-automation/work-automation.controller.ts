import { Body, Controller, Get, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { UsersService } from '../users/users.service';
import { SOURCE_ADAPTERS, TaskSourceAdapter } from './adapters/task-source-adapter';
import { UNSUPPORTED_SOURCES } from './adapters/unsupported-sources';
import { AutomationConfigService } from './automation-config.service';
import { LinkIdentityDto, ListIdentitiesQueryDto, SetReportingManagerDto } from './dto/identity.dto';
import { UpdateAutomationConfigDto } from './dto/work.dto';
import { EodDeliveryService } from './eod-delivery.service';
import { IdentityService } from './identity.service';
import { WorkSyncRun, WorkSyncRunDocument } from './schemas/work-sync.schema';
import { TaskSyncService } from './task-sync.service';
import { WorkSchedulerService } from './work-scheduler.service';

// Admin-only configuration and monitoring for the automatic To-Do / EOD
// system. Decided by role (owner/admin), never delegated by a permission list.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@PermissionExempt('not_grantable')
@Controller('work-automation/admin')
export class WorkAutomationController {
  constructor(
    private identities: IdentityService,
    private users: UsersService,
    private config: AutomationConfigService,
    private sync: TaskSyncService,
    private scheduler: WorkSchedulerService,
    private delivery: EodDeliveryService,
    @Inject(SOURCE_ADAPTERS) private adapters: TaskSourceAdapter[],
    @InjectModel(WorkSyncRun.name) private runs: Model<WorkSyncRunDocument>,
  ) {}

  // ---- settings ----

  @Get('config')
  async getConfig(@CurrentUser() user: JwtPayload) {
    const config = await this.config.get(user.organizationId);
    return {
      config,
      effectiveTimezone: await this.config.effectiveTimezone(user.organizationId, config),
      // Every source that exists, whether or not it is enabled — so an admin can see what can be switched on.
      sources: this.adapters.map((a) => ({ id: a.id, label: a.label, description: a.description, enabled: config.enabledSources.includes(a.id) })),
      // Requested sources that cannot be collected from, with the exact reason.
      unsupported: UNSUPPORTED_SOURCES,
    };
  }

  @Put('config')
  async updateConfig(@CurrentUser() user: JwtPayload, @Body() dto: UpdateAutomationConfigDto) {
    const known = new Set(this.adapters.map((a) => a.id));
    const config = await this.config.update(user.organizationId, { ...dto, ...(dto.enabledSources ? { enabledSources: dto.enabledSources.filter((s) => known.has(s)) } : {}) }, user.sub);
    return { config, effectiveTimezone: await this.config.effectiveTimezone(user.organizationId, config) };
  }

  // ---- synchronization monitor ----

  @Get('sync-status')
  async syncStatus(@CurrentUser() user: JwtPayload) {
    const recent = await this.runs.find({ organizationId: user.organizationId }).sort({ startedAt: -1 }).limit(60).exec();
    const lastByAdapter = new Map<string, WorkSyncRunDocument>();
    for (const r of recent) if (!lastByAdapter.has(r.adapterId)) lastByAdapter.set(r.adapterId, r);
    const cfg = await this.config.get(user.organizationId);
    return {
      adapters: this.adapters.map((a) => {
        const last = lastByAdapter.get(a.id);
        return { id: a.id, label: a.label, enabled: cfg.enabledSources.includes(a.id), last: last ? runView(last) : null };
      }),
      unresolvedIdentities: await this.identities.unresolvedCount(user.organizationId),
      recent: recent.map(runView),
    };
  }

  /** Runs a synchronization of the whole organization now. */
  @Post('sync/run')
  runSync(@CurrentUser() user: JwtPayload) {
    return this.sync.syncOrganization(user.organizationId, 'manual');
  }

  // ---- EOD ----

  /** Generates and delivers today's reports now, e.g. after a long outage (only today's business day is covered). Safe to repeat: nothing is generated or sent twice. */
  @Post('eod/run')
  runEod(@CurrentUser() user: JwtPayload) {
    return this.scheduler.runEodForOrganization(user.organizationId, { force: true });
  }

  /** Gives failed deliveries of a report a fresh set of attempts and sends them. */
  @Post('eod/:reportId/resend')
  async resend(@CurrentUser() user: JwtPayload, @Param('reportId') reportId: string) {
    const reset = await this.delivery.resetFailed(user.organizationId, reportId);
    const sent = await this.delivery.processDue(user.organizationId);
    return { reset, sent };
  }

  // ---- identities & hierarchy ----

  @Get('identities')
  listIdentities(@CurrentUser() user: JwtPayload, @Query() q: ListIdentitiesQueryDto) {
    return this.identities.list(user.organizationId, q.status, q.platform);
  }

  @Post('identities/:id/link')
  async link(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: LinkIdentityDto) {
    await this.identities.link(user.organizationId, id, dto.userId, user.sub);
    return { ok: true };
  }

  @Post('identities/:id/unlink')
  async unlink(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.identities.unlink(user.organizationId, id, user.sub);
    return { ok: true };
  }

  @Post('identities/:id/ignore')
  async ignore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.identities.ignore(user.organizationId, id, user.sub);
    return { ok: true };
  }

  /** Everyone in the business with their reporting manager — the admin's hierarchy editor. */
  @Get('hierarchy')
  hierarchy(@CurrentUser() user: JwtPayload) {
    return this.users.hierarchy(user.organizationId);
  }

  /** Sets (or clears) one person's reporting manager. Same validation as the Users page edit: active, same business, no loops. */
  @Put('hierarchy/:userId')
  async setManager(@CurrentUser() user: JwtPayload, @Param('userId') userId: string, @Body() dto: SetReportingManagerDto) {
    const patch: UpdateUserDto = { reportingManagerId: dto.managerId ?? null };
    await this.users.updateByAdmin(userId, patch, user.organizationId, user.sub, user);
    return { ok: true };
  }
}

function runView(r: WorkSyncRunDocument) {
  return {
    adapterId: r.adapterId,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    userId: r.userId,
    fetched: r.fetched,
    created: r.created,
    updated: r.updated,
    completed: r.completed,
    deactivated: r.deactivated,
    unresolved: r.unresolved,
    error: r.error,
  };
}
