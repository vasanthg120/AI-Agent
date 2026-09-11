import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CrmModule } from '../crm/crm.module';
import { EmailSlaModule } from '../email-sla/email-sla.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutlookConnection, OutlookConnectionSchema } from '../outlook/schemas/outlook-connection.schema';
import { UsersModule } from '../users/users.module';
import { AgentExecution, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { EmailFollowUpReminder, EmailFollowUpReminderSchema } from './schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';
import { EmailSyncJob, EmailSyncJobSchema } from './schemas/email-sync-job.schema';
import { CustomerTimelineController } from './customer-timeline.controller';
import { EmailIntelligenceController } from './email-intelligence.controller';
import { EmailIntelligenceSyncService } from './email-intelligence-sync.service';
import { EmailIntelligenceService } from './email-intelligence.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
      { name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema },
      // Read-only reuse of OutlookModule's schema class (not a DI export) —
      // EmailIntelligenceSyncService only ever needs `findOne({userId,
      // isActive:true})`, no OutlookService method exists for that shape so
      // this is simpler than adding one there for a single call site.
      { name: OutlookConnection.name, schema: OutlookConnectionSchema },
      // Phase 21 — sync-job history, written by EmailIntelligenceSyncService.
      { name: EmailSyncJob.name, schema: EmailSyncJobSchema },
      // Phase 21 follow-up — read-only reuse of Command Center's telemetry
      // collection (same "second module re-registers the schema" precedent
      // as OutlookConnection above), so previewSync can build a real
      // token/cost estimate from history and getProviderHealth can report
      // real recent success/failure, instead of either being invented.
      { name: AgentExecution.name, schema: AgentExecutionSchema },
    ]),
    // A single forced-tool-choice analyze_email call can legitimately exceed
    // 30s (confirmed live — a real regenerate call timed out at exactly
    // 30000ms with no error from python-agent/Anthropic, just NestJS giving
    // up too early; strict:true's grammar-constrained sampling, added in
    // Phase 17, plausibly adds some latency on top of the model's normal
    // response time). 90s gives real headroom without being unbounded.
    HttpModule.register({ timeout: 90_000 }),
    AuthModule,
    UsersModule,
    // One-directional: EmailIntelligenceModule -> CrmModule, never the
    // reverse — same shape as TimelineModule's documented pattern elsewhere.
    CrmModule,
    NotificationsModule,
    // Reuses ReservationService.reserve/settle/release exactly as chat.py
    // and business-knowledge-chat.service.ts already do — see callAnalyze's
    // own comment.
    BillingModule,
    // Email SLA + AI Follow-up action layer (isolated extension) — this
    // module calls EmailSlaService at two best-effort call-sites in
    // email-intelligence.service.ts; EmailSlaModule never imports back.
    EmailSlaModule,
  ],
  controllers: [EmailIntelligenceController, CustomerTimelineController],
  providers: [EmailIntelligenceService, EmailIntelligenceSyncService],
  // Phase 16: EmailIntelligenceService.list() (self-scoped) is consumed by
  // the new HomeDashboardModule, which sits above both this module and
  // CrmModule — safe since HomeDashboardModule imports both but neither of
  // them imports it back.
  exports: [EmailIntelligenceService],
})
export class EmailIntelligenceModule {}
