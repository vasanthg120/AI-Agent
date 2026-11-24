import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { businessDayOf } from '../common/business-day';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { AutomationConfigService } from './automation-config.service';
import { EodDeliveryService } from './eod-delivery.service';
import { EodReportService } from './eod-report.service';
import { TaskSyncService } from './task-sync.service';

/** Wall-clock minutes since midnight in a zone. */
export function minutesInZone(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

export const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** After this many minutes past the configured time a run is reported as "late" (the server was down, etc.). */
const LATE_AFTER_MINUTES = 30;

/**
 * The two background jobs, built on the same primitives as the store
 * scheduler (@nestjs/schedule, atomic claim, timezone-aware business days):
 *  - every 30 minutes: refresh every organization's task data;
 *  - every 10 minutes: for each organization whose EOD time has passed today,
 *    do one final sync, generate the report of every employee who has none yet,
 *    and deliver. "Has none yet" is re-evaluated each tick, so a crash,
 *    restart or late start simply resumes where it stopped until the day ends,
 *    and nothing is ever generated or sent twice.
 */
@Injectable()
export class WorkSchedulerService {
  private readonly logger = new Logger(WorkSchedulerService.name);

  constructor(
    @InjectModel(Organization.name) private orgs: Model<OrganizationDocument>,
    private config: AutomationConfigService,
    private sync: TaskSyncService,
    private eod: EodReportService,
    private delivery: EodDeliveryService,
  ) {}

  private async activeOrganizationIds(): Promise<string[]> {
    const rows = await this.orgs.find({ status: { $ne: 'archived' } }).select('_id status').limit(5000).lean().exec();
    return rows.filter((o) => (o as { status?: string }).status !== 'suspended').map((o) => o._id.toString());
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledSync(): Promise<void> {
    for (const organizationId of await this.activeOrganizationIds()) {
      try {
        await this.sync.syncOrganization(organizationId, 'schedule');
      } catch (err) {
        this.logger.error(`Scheduled sync failed for org ${organizationId}: ${(err as Error).message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async eodTick(): Promise<void> {
    for (const organizationId of await this.activeOrganizationIds()) {
      try {
        await this.runEodForOrganization(organizationId);
      } catch (err) {
        // One organization's failure never stops the others.
        this.logger.error(`EOD run failed for org ${organizationId}: ${(err as Error).message}`);
      }
    }
  }

  /** One pass for one organization. Exposed for tests and the admin "run now". */
  async runEodForOrganization(organizationId: string, opts: { now?: Date; force?: boolean } = {}): Promise<{ generated: number; delivered: number; skipped?: string }> {
    const now = opts.now ?? new Date();
    const cfg = await this.config.get(organizationId);
    if (!cfg.enabled) return { generated: 0, delivered: 0, skipped: 'disabled' };
    const timezone = await this.config.effectiveTimezone(organizationId, cfg);
    const eodMinutes = hhmmToMinutes(cfg.eodTime);
    const nowMinutes = minutesInZone(timezone, now);
    if (!opts.force && nowMinutes < eodMinutes) {
      // Not EOD yet — but deliveries that failed earlier may be due for retry.
      return { generated: 0, delivered: await this.delivery.processDue(organizationId, now), skipped: 'before_eod_time' };
    }
    const date = businessDayOf(timezone, now);

    // Only one pass per organization at a time (a lock, not a once-a-day claim: the next tick resumes unfinished work).
    if (!(await this.sync.claim(organizationId, 'eod', 0, now))) return { generated: 0, delivered: 0, skipped: 'already_running' };
    try {
      // Step 1: the final synchronization of the day (at most once per day).
      if (await this.sync.claim(organizationId, `eod-sync:${date}`, 24 * 60 * 60 * 1000, now)) {
        await this.sync.syncOrganization(organizationId, 'eod', { now }).catch((err) => this.logger.error(`Final sync failed for org ${organizationId}: ${(err as Error).message}`));
      }

      // Steps 2-7: one report per employee with tracked work; each is generated at most once.
      const wasMissed = !opts.force && nowMinutes > eodMinutes + LATE_AFTER_MINUTES;
      let generated = 0;
      for (const userId of await this.eod.eligibleEmployees(organizationId, date)) {
        const res = await this.eod.generateForUser(organizationId, userId, date, { now, wasMissed, trigger: opts.force ? 'manual' : 'schedule', maxAttempts: cfg.maxDeliveryAttempts });
        if (res.created && res.report) {
          generated += 1;
          await this.delivery.enqueue(res.report);
        } else if (res.status === 'already_generated' && res.report) {
          // Crash recovery: a generated report whose delivery rows were never created gets them now (idempotent).
          await this.delivery.enqueue(res.report);
        }
      }

      // Step 8: send (and retry what is due).
      const delivered = await this.delivery.processDue(organizationId, now);
      return { generated, delivered };
    } finally {
      await this.sync.release(organizationId, 'eod');
    }
  }
}
