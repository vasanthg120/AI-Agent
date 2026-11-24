import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { businessDayOf } from '../common/business-day';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AutomationConfigService } from './automation-config.service';
import { EodDelivery, EodDeliveryDocument } from './schemas/eod-delivery.schema';
import { EodReportService } from './eod-report.service';
import { EodReport, EodReportDocument } from './schemas/eod-report.schema';
import { TaskQueryService } from './task-query.service';
import { hhmmToMinutes, minutesInZone } from './work-scheduler.service';
import { isAdminLike, WorkAccessService } from './work-access.service';

export type ReportState = 'generated' | 'failed' | 'generating' | 'missing' | 'not_due' | 'no_work';

export interface TeamRow {
  userId: string;
  name: string;
  email: string;
  counts: { open: number; overdue: number; completedToday: number; blocked: number; awaitingVerification: number };
  report: { state: ReportState; reportId?: string; generatedAt?: Date; deliveries: { employee?: string; manager?: string } };
}

/** The manager dashboard: the people the caller may see, their task state, and whether today's EOD exists and was delivered. */
@Injectable()
export class TeamDashboardService {
  constructor(
    @InjectModel(User.name) private users: Model<UserDocument>,
    @InjectModel(EodReport.name) private reports: Model<EodReportDocument>,
    @InjectModel(EodDelivery.name) private deliveries: Model<EodDeliveryDocument>,
    private access: WorkAccessService,
    private query: TaskQueryService,
    private config: AutomationConfigService,
    private eodReport: EodReportService,
  ) {}

  async dashboard(caller: JwtPayload, opts: { date?: string; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const organizationId = caller.organizationId;
    const cfg = await this.config.get(organizationId);
    const timezone = await this.config.effectiveTimezone(organizationId, cfg);
    const today = businessDayOf(timezone, now);
    const date = opts.date ?? today;
    const eodReached = date < today || minutesInZone(timezone, now) >= hhmmToMinutes(cfg.eodTime);

    // Everyone the caller may see, other than themself (their own board is "My To-Do"), minus deactivated accounts.
    const visible = (await this.access.visibleUserIds(caller)).filter((id) => id !== caller.sub);
    const people = visible.length ? await this.users.find({ _id: { $in: visible }, organizationId, active: true }).select('name email').lean().exec() : [];
    const ids = people.map((p) => p._id.toString());

    const eligible = new Set(await this.eodReport.eligibleEmployees(organizationId, date));
    const counts = await this.query.teamCounts(organizationId, ids, { now });
    const reports = ids.length ? await this.reports.find({ organizationId, date, userId: { $in: ids } }).exec() : [];
    const byUser = new Map(reports.map((r) => [r.userId, r]));
    const deliveries = reports.length ? await this.deliveries.find({ organizationId, reportId: { $in: reports.map((r) => r._id.toString()) } }).exec() : [];

    const rows: TeamRow[] = people.map((p) => {
      const id = p._id.toString();
      const c = counts.get(id) ?? { open: 0, overdue: 0, completedToday: 0, blocked: 0, awaitingVerification: 0 };
      const r = byUser.get(id);
      let state: ReportState;
      if (r) state = r.status;
      // Anyone who should get a report (see EodReportService.eligibleEmployees) and has none once EOD time has passed is missing one.
      else if (!eligible.has(id)) state = 'no_work';
      else state = eodReached ? 'missing' : 'not_due';
      const mine = r ? deliveries.filter((d) => d.reportId === r._id.toString()) : [];
      return {
        userId: id,
        name: p.name,
        email: p.email,
        counts: c,
        report: {
          state,
          reportId: r?._id.toString(),
          generatedAt: r?.generatedAt,
          deliveries: { employee: mine.find((d) => d.role === 'employee')?.status, manager: mine.find((d) => d.role === 'manager')?.status },
        },
      };
    });

    const sum = (f: (r: TeamRow) => number) => rows.reduce((n, r) => n + f(r), 0);
    return {
      date,
      timezone,
      eodTime: cfg.eodTime,
      admin: isAdminLike(caller),
      totals: {
        people: rows.length,
        open: sum((r) => r.counts.open),
        overdue: sum((r) => r.counts.overdue),
        completedToday: sum((r) => r.counts.completedToday),
        reportsGenerated: rows.filter((r) => r.report.state === 'generated').length,
        reportsMissing: rows.filter((r) => r.report.state === 'missing' || r.report.state === 'failed').length,
      },
      rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
