import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { businessDayRange } from '../common/business-day';
import { User, UserDocument } from '../users/schemas/user.schema';
import { RecordReader } from './adapters/task-source-adapter';
import { AutomationConfigService } from './automation-config.service';
import { EodAiClient } from './eod-ai.client';
import { buildSections, deterministicSummary, ExtraFacts } from './eod-sections';
import { hasTeamRole, isOwner } from '../common/team-roster';
import { EodAssessment } from './schemas/eod-report.schema';
import { EodReport, EodReportDocument } from './schemas/eod-report.schema';
import { WorkSyncRun, WorkSyncRunDocument } from './schemas/work-sync.schema';
import { TaskQueryService } from './task-query.service';

/** A report stuck in "generating" this long is treated as abandoned (the process died) and may be retaken. */
const STALE_GENERATING_MS = 15 * 60 * 1000;

export interface GenerateOptions {
  now?: Date;
  wasMissed?: boolean;
  trigger?: 'schedule' | 'manual';
  /** Retry cap for a report that keeps failing. */
  maxAttempts?: number;
}

export interface GenerateResult {
  report: EodReportDocument | null;
  /** true when this call produced the report; false when it already existed (duplicate prevented) or could not be taken. */
  created: boolean;
  status: 'generated' | 'already_generated' | 'in_progress' | 'failed' | 'gave_up';
}

@Injectable()
export class EodReportService {
  private readonly logger = new Logger(EodReportService.name);

  constructor(
    @InjectModel(EodReport.name) private reports: Model<EodReportDocument>,
    @InjectModel(User.name) private users: Model<UserDocument>,
    @InjectModel(WorkSyncRun.name) private runs: Model<WorkSyncRunDocument>,
    private query: TaskQueryService,
    private config: AutomationConfigService,
    private reader: RecordReader,
    private ai: EodAiClient,
  ) {}

  /**
   * Generates (at most once) one employee's report for one business day.
   * Safe to call repeatedly and concurrently: the unique (org, user, date)
   * row is the claim, a finished report is returned as-is, and a failed or
   * abandoned one is retaken atomically, up to maxAttempts.
   */
  async generateForUser(organizationId: string, userId: string, date: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
    const now = opts.now ?? new Date();
    const maxAttempts = opts.maxAttempts ?? 3;
    const timezone = await this.config.effectiveTimezone(organizationId);

    const claimed = await this.claim(organizationId, userId, date, timezone, now, maxAttempts, opts);
    if (claimed.status !== 'claimed') return { report: claimed.report, created: false, status: claimed.status };
    const report = claimed.report;

    try {
      const user = await this.users.findOne({ _id: userId, organizationId }).select('name email reportingManagerId').lean().exec();
      if (!user) throw new Error('Employee not found in this organization.');

      const day = await this.query.dayView(organizationId, userId, { date, now });
      const { start, end } = businessDayRange(timezone, date, date);
      const dataGaps: string[] = [];
      const extra: ExtraFacts = { meetings: { source: 'not_connected', items: [] }, repliesSent: 0, crmUpdates: [], activityReadable: true };

      try {
        const m = await this.ai.meetings(organizationId, userId, start, end);
        extra.meetings = m.connected ? { source: 'outlook_calendar', items: m.meetings } : { source: 'not_connected', items: [] };
        if (!m.connected) dataGaps.push('Outlook calendar is not connected, so meetings are not listed.');
      } catch (err) {
        extra.meetings = { source: 'unavailable', items: [] };
        dataGaps.push('Meetings could not be read from the calendar.');
        this.logger.warn(`Calendar read failed for ${userId}: ${(err as Error).message}`);
      }

      try {
        const sent = await this.reader.find('email_intelligence_items', { organizationId, userId, sentAt: { $gte: start, $lt: end } }, { limit: 500 });
        extra.repliesSent = sent.length;
        const acts = await this.reader.find('crm_activities', { organizationId, actorUserId: userId, occurredAt: { $gte: start, $lt: end } }, { limit: 100, sort: { occurredAt: -1 } });
        extra.crmUpdates = acts.map((a) => ({ kind: String(a.kind), entity: String(a.entity), customerName: a.customerName, value: a.value, currency: a.currency, at: new Date(a.occurredAt) }));
      } catch (err) {
        extra.activityReadable = false;
        dataGaps.push('Email and CRM activity counts could not be read.');
        this.logger.warn(`Activity read failed for ${userId}: ${(err as Error).message}`);
      }

      const health = await this.syncHealth(organizationId, now);
      dataGaps.push(...health.notes);
      extra.syncHealth = health.state;
      extra.syncNotes = health.notes;
      // What the person did themself in Haive today (their own status changes / verification requests).
      extra.ownActions = (await this.query.activity(organizationId, userId, { date, now })).filter((a) => a.actor === userId).length;

      const sections = buildSections(day, extra);
      let summary = await this.ai.summarize(organizationId, userId, user.name, date, sections, dataGaps);
      const summarySource = summary ? 'ai' : 'deterministic';
      if (!summary) summary = deterministicSummary(user.name, date, sections);

      const done = await this.reports
        .findOneAndUpdate(
          { _id: report._id, status: 'generating' },
          {
            $set: { status: 'generated', generatedAt: new Date(), sections, summary, summarySource, dataGaps, employeeName: user.name, employeeEmail: user.email, ...(user.reportingManagerId ? { managerId: user.reportingManagerId } : {}) },
            $unset: { error: '' },
          },
          { new: true },
        )
        .exec();
      return { report: done, created: !!done, status: 'generated' };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`EOD generation failed for ${userId} on ${date}: ${message}`);
      await this.reports.updateOne({ _id: report._id, status: 'generating' }, { $set: { status: 'failed', error: message.slice(0, 500) } }).exec();
      return { report: null, created: false, status: 'failed' };
    }
  }

  private async claim(organizationId: string, userId: string, date: string, timezone: string, now: Date, maxAttempts: number, opts: GenerateOptions) {
    const fresh = { organizationId, userId, date, timezone, status: 'generating' as const, attempts: 1, startedAt: now, wasMissed: !!opts.wasMissed, trigger: opts.trigger ?? 'schedule', dataGaps: [] };
    try {
      const created = await this.reports.create(fresh);
      return { status: 'claimed' as const, report: created };
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    const existing = await this.reports.findOne({ organizationId, userId, date }).exec();
    if (!existing) return { status: 'in_progress' as const, report: null };
    if (existing.status === 'generated') return { status: 'already_generated' as const, report: existing };
    if (existing.attempts >= maxAttempts && existing.status === 'failed') return { status: 'gave_up' as const, report: existing };
    // Retake a failed report, or one whose generator died, atomically: only one caller wins.
    const retaken = await this.reports
      .findOneAndUpdate(
        {
          _id: existing._id,
          attempts: { $lt: maxAttempts },
          $or: [{ status: 'failed' }, { status: 'generating', startedAt: { $lt: new Date(now.getTime() - STALE_GENERATING_MS) } }],
        },
        { $set: { status: 'generating', startedAt: now }, $inc: { attempts: 1 } },
        { new: true },
      )
      .exec();
    return retaken ? { status: 'claimed' as const, report: retaken } : { status: 'in_progress' as const, report: existing };
  }

  /**
   * Whether the data this report rests on can be trusted. For every source the
   * organization has switched on: its latest run in the last 24 hours must have
   * succeeded in full. A failed or partial run is "degraded"; a source that has not
   * run at all is "unknown". Either way the report says so instead of reading
   * missing data as an idle employee.
   */
  async syncHealth(organizationId: string, now: Date): Promise<{ state: EodAssessment['syncHealth']; notes: string[] }> {
    const cfg = await this.config.get(organizationId);
    const runs = await this.runs.find({ organizationId, startedAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }).sort({ startedAt: -1 }).limit(500).exec();
    const notes: string[] = [];
    let degraded = false;
    let unknown = false;
    for (const adapterId of cfg.enabledSources) {
      const latest = runs.find((r) => r.adapterId === adapterId);
      if (!latest) {
        unknown = true;
        notes.push(`The "${adapterId}" source has not synchronized in the last 24 hours.`);
      } else if (latest.status === 'failed') {
        degraded = true;
        notes.push(`The "${adapterId}" synchronization failed, so its tasks may be missing or out of date.`);
      } else if (latest.status === 'partial') {
        degraded = true;
        notes.push(`The "${adapterId}" synchronization read only part of its data.`);
      }
    }
    return { state: degraded ? 'degraded' : unknown ? 'unknown' : 'ok', notes };
  }

  /**
   * Everyone who should receive an EOD for `date`: every active employee — a team
   * role (manager / consultant / AI-role member, never the organization's owner),
   * plus anyone who has tracked work whatever their role. A person with nothing
   * assigned still gets a report, saying so.
   */
  async eligibleEmployees(organizationId: string, date: string): Promise<string[]> {
    const timezone = await this.config.effectiveTimezone(organizationId);
    const { start, end } = businessDayRange(timezone, date, date);
    const withWork = new Set(await this.query.assigneesWithWork(organizationId, start, end));
    const people = await this.users.find({ organizationId, active: true }).select('roles').lean().exec();
    return people.filter((u) => withWork.has(u._id.toString()) || (hasTeamRole(u.roles) && !isOwner(u.roles))).map((u) => u._id.toString());
  }
}
