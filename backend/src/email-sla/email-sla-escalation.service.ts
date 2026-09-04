import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { EmailEscalationRule, EmailEscalationRuleDocument } from './schemas/email-escalation-rule.schema';
import { EmailSlaEvent, EmailSlaEventDocument } from './schemas/email-sla-event.schema';
import { EmailSlaRecord, EmailSlaRecordDocument } from './schemas/email-sla-record.schema';

const BATCH_SIZE = 500;

/**
 * One scheduler for both breach detection and escalation (spec §8/§9's own
 * "do not create multiple independent schedulers for the same task"). Same
 * bounded-batch, indexed-query, per-record-try/catch shape as this
 * codebase's existing crons (ReservationService.sweepExpiredReservations,
 * SubscriptionRenewalService.processDueRenewals) — never a full collection
 * scan, never lets one bad record kill the whole tick.
 */
@Injectable()
export class EmailSlaEscalationService {
  private readonly logger = new Logger(EmailSlaEscalationService.name);

  constructor(
    @InjectModel(EmailSlaRecord.name) private recordModel: Model<EmailSlaRecordDocument>,
    @InjectModel(EmailSlaEvent.name) private eventModel: Model<EmailSlaEventDocument>,
    @InjectModel(EmailEscalationRule.name) private ruleModel: Model<EmailEscalationRuleDocument>,
    private notifications: NotificationsService,
    private usersService: UsersService,
    private config: ConfigService,
  ) {}

  listRules(organizationId: string) {
    return this.ruleModel.find({ organizationId }).sort({ priority: 1, escalationLevel: 1 }).exec();
  }

  upsertRule(
    organizationId: string,
    dto: { priority: string; escalationLevel: number; delayMinutes: number; notifyAssignedUser?: boolean; notifyManager?: boolean; notifyAdmin?: boolean; enabled?: boolean },
  ) {
    const { priority, escalationLevel, ...rest } = dto;
    return this.ruleModel
      .findOneAndUpdate({ organizationId, priority, escalationLevel }, { $set: rest }, { upsert: true, new: true })
      .exec();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scanForBreachesAndEscalations(): Promise<void> {
    if (!(this.config.get<boolean>('emailSla.enabled') ?? false)) return;

    const now = new Date();

    // 1) Breach detection — indexed query, bounded batch, idempotent (only
    // ever touches records not already BREACHED/RESPONDED/EXCLUDED).
    const overdue = await this.recordModel
      .find({ status: { $in: ['PENDING', 'IN_PROGRESS'] }, slaDueAt: { $lt: now } })
      .limit(BATCH_SIZE)
      .exec();
    for (const record of overdue) {
      try {
        record.status = 'BREACHED';
        record.breachedAt = record.breachedAt ?? now;
        await record.save();
        await this.eventModel.create({ organizationId: record.organizationId, recordId: record._id.toString(), type: 'breached', metadata: {} });
      } catch (err) {
        this.logger.error(`Breach marking failed for SLA record ${record._id.toString()}: ${(err as Error).message}`);
      }
    }

    if (!(this.config.get<boolean>('emailSla.escalationEnabled') ?? false)) return;

    // 2) Escalation — same tick, breached-or-already-escalating records only.
    // escalationLevel only ever advances, so a level can never fire twice.
    const escalationCandidates = await this.recordModel
      .find({ status: { $in: ['BREACHED', 'ESCALATED'] }, breachedAt: { $ne: null } })
      .limit(BATCH_SIZE)
      .exec();
    for (const record of escalationCandidates) {
      try {
        await this.tryEscalate(record, now);
      } catch (err) {
        this.logger.error(`Escalation check failed for SLA record ${record._id.toString()}: ${(err as Error).message}`);
      }
    }
  }

  private async tryEscalate(record: EmailSlaRecordDocument, now: Date): Promise<void> {
    const nextLevel = record.escalationLevel + 1;
    const rule = await this.ruleModel.findOne({ organizationId: record.organizationId, priority: record.priority, escalationLevel: nextLevel, enabled: true }).exec();
    if (!rule) return; // no further level configured for this priority

    const breachedAt = record.breachedAt ?? now;
    const elapsedMinutes = (now.getTime() - breachedAt.getTime()) / 60_000;
    if (elapsedMinutes < rule.delayMinutes) return; // not due yet — checked again next tick

    const recipients = await this.resolveRecipients(record.organizationId, record.assignedUserId, rule);
    await Promise.allSettled(
      recipients.map((userId) =>
        this.notifications.create(
          userId,
          {
            kind: 'sla_breach',
            title: `SLA breach escalation — level ${nextLevel}`,
            description: `An email response is overdue (priority: ${record.priority}).`,
            source: 'email-sla-escalation',
            entityType: 'email',
            entityId: record.emailId,
          },
          record.organizationId,
        ),
      ),
    );

    record.status = 'ESCALATED';
    record.escalationLevel = nextLevel;
    record.escalatedAt = now;
    await record.save();
    await this.eventModel.create({
      organizationId: record.organizationId,
      recordId: record._id.toString(),
      type: 'escalated',
      metadata: { escalationLevel: nextLevel, recipientCount: recipients.length },
    });
  }

  // Mirrors EmailIntelligenceService.notifyManagers's exact role-filter
  // shape (manager scoped to the assignee's store, falling back to
  // owner/admin when none) — reused here rather than re-invented, plus the
  // assigned user themselves when the rule asks for it.
  private async resolveRecipients(organizationId: string, assignedUserId: string, rule: EmailEscalationRuleDocument): Promise<string[]> {
    const recipients = new Set<string>();
    if (rule.notifyAssignedUser) recipients.add(assignedUserId);

    if (rule.notifyManager || rule.notifyAdmin) {
      const users = await this.usersService.findAll(organizationId);
      const assignee = users.find((u) => u._id.toString() === assignedUserId);
      if (rule.notifyManager) {
        const managers = users.filter((u) => u._id.toString() !== assignedUserId && u.roles.includes('manager') && (!assignee?.storeId || u.storeId === assignee.storeId));
        managers.forEach((u) => recipients.add(u._id.toString()));
      }
      if (rule.notifyAdmin) {
        const admins = users.filter((u) => u._id.toString() !== assignedUserId && (u.roles.includes('owner') || u.roles.includes('admin')));
        admins.forEach((u) => recipients.add(u._id.toString()));
      }
    }
    return [...recipients];
  }
}
