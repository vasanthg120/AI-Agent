import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { EmailSlaModule } from '../email-sla/email-sla.module';
import { EmailFollowUpScheduler } from './email-follow-up.scheduler';

// The AI Follow-up Agent — a thin layer ABOVE both EmailSlaModule and
// EmailIntelligenceModule (same layering already used for the analytics
// dashboard, see EmailIntelligenceModule's own docblock). No new schema, no
// new controller, no new HTTP surface here: it only wires the existing
// EmailSlaService.listBreached() read to the existing
// EmailIntelligenceService.createSlaBreachFollowUp() write on a schedule.
// Every actual endpoint the frontend uses (list/generate/approve/send/
// dismiss follow-ups) already lives on EmailIntelligenceController.
@Module({
  imports: [ConfigModule, EmailSlaModule, EmailIntelligenceModule],
  providers: [EmailFollowUpScheduler],
})
export class EmailFollowUpModule {}
