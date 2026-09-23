import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailIntelligenceService } from '../email-intelligence/email-intelligence.service';
import { EmailSlaService } from '../email-sla/email-sla.service';

const BATCH_SIZE = 200;

/**
 * The AI Follow-up Agent's SLA-breach trigger. Deliberately its OWN cron
 * tick, not a change inside EmailSlaEscalationService's existing one (spec's
 * own "reuse the existing scheduler, do not create multiple schedulers
 * checking the same records" is about not re-scanning the SAME records for
 * the SAME purpose — this queries a different status set for a genuinely
 * different task, drafting, and email-sla must never import
 * email-intelligence, see EmailSlaModule's own docblock). Same cadence
 * (every 5 minutes) and same bounded-batch/per-record-try/catch convention
 * as that scheduler, so nothing here behaves like a second, uncoordinated
 * background system.
 *
 * Sits above both EmailSlaModule and EmailIntelligenceModule (same layering
 * EmailIntelligenceModule's own docblock already uses for the dashboard
 * module) — sole responsibility is "find breached records with no follow-up
 * yet, ask email-intelligence to handle it". All real logic (idempotent
 * creation, context-gathering, AI drafting, notification) lives in
 * EmailIntelligenceService.createSlaBreachFollowUp, which this only calls.
 */
@Injectable()
export class EmailFollowUpScheduler {
  private readonly logger = new Logger(EmailFollowUpScheduler.name);

  constructor(
    private emailSla: EmailSlaService,
    private emailIntelligence: EmailIntelligenceService,
    private config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scanBreachedForFollowUps(): Promise<void> {
    if (!(this.config.get<boolean>('emailSla.enabled') ?? false)) return;
    if (!(this.config.get<boolean>('emailSla.aiFollowupActionsEnabled') ?? false)) return;

    const breached = await this.emailSla.listBreached(BATCH_SIZE);
    for (const record of breached) {
      try {
        // Idempotent internally (unique index on {organizationId,
        // emailIntelligenceItemId, reminderType}) — safe to call every tick
        // for the same still-breached record until it's resolved.
        await this.emailIntelligence.createSlaBreachFollowUp({
          organizationId: record.organizationId,
          emailId: record.emailId,
          assignedUserId: record.assignedUserId,
          slaRecordId: record._id.toString(),
        });
      } catch (err) {
        this.logger.error(`AI follow-up trigger failed for SLA record ${record._id.toString()}: ${(err as Error).message}`);
      }
    }
  }
}
