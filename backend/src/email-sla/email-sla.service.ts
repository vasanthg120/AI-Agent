import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailSlaCalculatorService } from './email-sla-calculator.service';
import { EmailSlaPolicyService } from './email-sla-policy.service';
import { EmailSlaEvent, EmailSlaEventDocument, EmailSlaEventType } from './schemas/email-sla-event.schema';
import { EmailSlaRecord, EmailSlaRecordDocument, EmailSlaStatus } from './schemas/email-sla-record.schema';

const DUPLICATE_KEY_ERROR = 11000;

// The narrow subset of EmailIntelligenceItem this module actually needs —
// a local shape, not an import of email-intelligence's schema type, so this
// module stays genuinely isolated (email-intelligence imports email-sla,
// never the reverse — see email-sla.module.ts).
export interface SlaEligibleEmail {
  organizationId: string;
  emailId: string;
  assignedUserId: string;
  receivedAt: Date;
  priority: string;
  // Reuses the existing classification decision — only 'draft_ready' items
  // (the system already decided this needs a human reply) get tracked.
  // Everything else (sent-from-own-mailbox, deterministic no-reply-needed,
  // validation_failed, already-approved/sent) is excluded, never re-decided
  // here.
  aiStatus: string;
}

@Injectable()
export class EmailSlaService {
  private readonly logger = new Logger(EmailSlaService.name);

  constructor(
    @InjectModel(EmailSlaRecord.name) private recordModel: Model<EmailSlaRecordDocument>,
    @InjectModel(EmailSlaEvent.name) private eventModel: Model<EmailSlaEventDocument>,
    private calculator: EmailSlaCalculatorService,
    private policyService: EmailSlaPolicyService,
    private config: ConfigService,
  ) {}

  private isEnabled(): boolean {
    return this.config.get<boolean>('emailSla.enabled') ?? false;
  }

  /** Called (best-effort, from email-intelligence.service.ts) right after an
   * item is created/updated. No-ops entirely when the feature flag is off,
   * or when the item isn't eligible — never creates an SLA record for a
   * sent/draft-not-needed/internal/excluded email (spec §6), because
   * eligibility is exactly "the existing classification already decided
   * this needs a reply", nothing new invented here. Idempotent: upserts on
   * the unique {organizationId, emailId} index, so a duplicate sync event
   * or a second analyzeAndCreate call for the same email never creates a
   * second record. */
  async createOrUpdateRecordForItem(email: SlaEligibleEmail): Promise<void> {
    if (!this.isEnabled()) return;
    if (email.aiStatus !== 'draft_ready') return;

    const existing = await this.recordModel.findOne({ organizationId: email.organizationId, emailId: email.emailId }).exec();
    if (existing) return; // already tracked — never re-derive slaDueAt after the fact

    const policy = await this.policyService.resolvePolicy(email.organizationId, email.priority);
    const hours = await this.policyService.resolveBusinessHours(email.organizationId);
    const slaDueAt = this.calculator.calculateDueAt(email.receivedAt, policy.firstResponseTimeMinutes, hours, policy.businessHoursEnabled);

    try {
      const record = await this.recordModel.create({
        organizationId: email.organizationId,
        emailId: email.emailId,
        assignedUserId: email.assignedUserId,
        receivedAt: email.receivedAt,
        slaStartedAt: email.receivedAt,
        slaDueAt,
        status: 'PENDING',
        priority: email.priority,
        businessHoursApplied: policy.businessHoursEnabled,
      });
      await this.writeEvent(record, 'created', {});
    } catch (err) {
      // Concurrent creation for the same email — the unique index is the
      // authoritative dedup guard, same pattern as
      // EmailIntelligenceService.analyzeAndCreate's own DUPLICATE_KEY_ERROR
      // handling.
      if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR) return;
      throw err;
    }
  }

  /** Called (best-effort, from email-intelligence.service.ts's send()) right
   * after a real, successful Graph dispatch. Sets firstResponseAt from the
   * real send timestamp — never a draft/approval timestamp — and flips
   * isBreached by comparing against the slaDueAt that was already
   * calculated and stored (never recomputed at this point, so a later
   * policy change can't retroactively change whether a past response was
   * on time). */
  async recordFirstResponse(organizationId: string, emailId: string, sentAt: Date): Promise<void> {
    if (!this.isEnabled()) return;
    const record = await this.recordModel.findOne({ organizationId, emailId }).exec();
    if (!record || record.status === 'RESPONDED') return; // no record (not eligible) or already recorded

    record.firstResponseAt = sentAt;
    record.responseTimeSeconds = Math.max(0, Math.round((sentAt.getTime() - record.receivedAt.getTime()) / 1000));
    record.isBreached = sentAt.getTime() > record.slaDueAt.getTime();
    record.status = 'RESPONDED';
    await record.save();
    await this.writeEvent(record, 'responded', { responseTimeSeconds: record.responseTimeSeconds, isBreached: record.isBreached });
  }

  listRecords(organizationId: string, filters: { status?: EmailSlaStatus; assignedUserId?: string } = {}) {
    return this.recordModel
      .find({ organizationId, ...filters })
      .sort({ slaDueAt: 1 })
      .exec();
  }

  async getRecord(organizationId: string, id: string): Promise<EmailSlaRecordDocument> {
    const record = await this.recordModel.findOne({ _id: id, organizationId }).exec();
    if (!record) throw new NotFoundException('SLA record not found.');
    return record;
  }

  listEvents(organizationId: string, recordId?: string) {
    return this.eventModel
      .find({ organizationId, ...(recordId ? { recordId } : {}) })
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  async resolveRecord(organizationId: string, id: string): Promise<EmailSlaRecordDocument> {
    const record = await this.getRecord(organizationId, id);
    record.status = 'RESPONDED';
    await record.save();
    await this.writeEvent(record, 'resolved', {});
    return record;
  }

  async excludeRecord(organizationId: string, id: string, reason?: string): Promise<EmailSlaRecordDocument> {
    const record = await this.getRecord(organizationId, id);
    record.status = 'EXCLUDED';
    record.excludedReason = reason;
    await record.save();
    await this.writeEvent(record, 'excluded', { reason });
    return record;
  }

  private async writeEvent(record: EmailSlaRecordDocument, type: EmailSlaEventType, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.eventModel.create({ organizationId: record.organizationId, recordId: record._id.toString(), type, metadata });
    } catch (err) {
      // An audit-trail write failure must never break the actual state
      // transition it's describing — same "persistence must never break the
      // real thing" instinct as tracing.py's execution_store writes.
      this.logger.error(`SLA event write failed (record ${record._id.toString()}, type ${type}): ${(err as Error).message}`);
    }
  }

  /** Real Mongo aggregations — every number here is computed from
   * EmailSlaRecord, never a static/mocked value (spec §14's own explicit
   * requirement). */
  async getDashboard(organizationId: string) {
    const [totals, responded, byPriority, byEmployee] = await Promise.all([
      this.recordModel.aggregate([
        { $match: { organizationId } },
        {
          $group: {
            _id: null,
            totalEligible: { $sum: 1 },
            breached: { $sum: { $cond: ['$isBreached', 1, 0] } },
            openOverdue: { $sum: { $cond: [{ $in: ['$status', ['PENDING', 'IN_PROGRESS', 'BREACHED']] }, 1, 0] } },
            escalated: { $sum: { $cond: [{ $eq: ['$status', 'ESCALATED'] }, 1, 0] } },
            respondedCount: { $sum: { $cond: [{ $eq: ['$status', 'RESPONDED'] }, 1, 0] } },
            respondedWithinSla: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'RESPONDED'] }, { $eq: ['$isBreached', false] }] }, 1, 0] } },
          },
        },
      ]).exec(),
      this.recordModel
        .aggregate<{ _id: null; times: number[] }>([
          { $match: { organizationId, status: 'RESPONDED', responseTimeSeconds: { $ne: null } } },
          { $group: { _id: null, times: { $push: '$responseTimeSeconds' } } },
        ])
        .exec(),
      this.recordModel.aggregate([
        { $match: { organizationId } },
        { $group: { _id: '$priority', total: { $sum: 1 }, breached: { $sum: { $cond: ['$isBreached', 1, 0] } }, avgResponseSeconds: { $avg: '$responseTimeSeconds' } } },
      ]).exec(),
      this.recordModel.aggregate([
        { $match: { organizationId } },
        { $group: { _id: '$assignedUserId', total: { $sum: 1 }, breached: { $sum: { $cond: ['$isBreached', 1, 0] } } } },
      ]).exec(),
    ]);

    const t = totals[0] ?? { totalEligible: 0, breached: 0, openOverdue: 0, escalated: 0, respondedCount: 0, respondedWithinSla: 0 };
    const times: number[] = (responded[0]?.times ?? []).slice().sort((a, b) => a - b);
    const avgResponseSeconds = times.length ? times.reduce((s, v) => s + v, 0) / times.length : null;
    const medianResponseSeconds = times.length ? times[Math.floor((times.length - 1) / 2)] : null;

    return {
      totalEligible: t.totalEligible,
      respondedWithinSla: t.respondedWithinSla,
      compliancePct: t.respondedCount > 0 ? Math.round((t.respondedWithinSla / t.respondedCount) * 100) : null,
      breached: t.breached,
      openOverdue: t.openOverdue,
      escalated: t.escalated,
      avgResponseSeconds,
      medianResponseSeconds,
      byPriority: byPriority.map((r) => ({ priority: r._id, total: r.total, breached: r.breached, avgResponseSeconds: r.avgResponseSeconds ?? null })),
      byEmployee: byEmployee.map((r) => ({ assignedUserId: r._id, total: r.total, breached: r.breached })),
    };
  }
}
