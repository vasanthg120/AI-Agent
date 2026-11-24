import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { GmailConnection, GmailConnectionSchema } from '../gmail/schemas/gmail-connection.schema';
import { MailModule } from '../mail/mail.module';
import { OutlookConnection, OutlookConnectionSchema } from '../outlook/schemas/outlook-connection.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { CrmTaskAdapter } from './adapters/crm-task.adapter';
import { EmailTaskAdapter } from './adapters/email-task.adapter';
import { GmailActionsSource, GmailTaskAdapter, HttpGmailActionsSource } from './adapters/gmail-task.adapter';
import { MongoRecordReader, RecordReader, SOURCE_ADAPTERS } from './adapters/task-source-adapter';
import { AutomationConfigService } from './automation-config.service';
import { EodAiClient } from './eod-ai.client';
import { EodDeliveryService } from './eod-delivery.service';
import { EodRecipientResolver } from './eod-recipient.resolver';
import { EodReportService } from './eod-report.service';
import { IdentityService } from './identity.service';
import { AutomationConfig, AutomationConfigSchema } from './schemas/automation-config.schema';
import { EodDelivery, EodDeliverySchema } from './schemas/eod-delivery.schema';
import { EodReport, EodReportSchema } from './schemas/eod-report.schema';
import { ExternalIdentity, ExternalIdentitySchema } from './schemas/external-identity.schema';
import { WorkSyncRun, WorkSyncRunSchema, WorkSyncState, WorkSyncStateSchema } from './schemas/work-sync.schema';
import { WorkTaskEvent, WorkTaskEventSchema } from './schemas/work-task-event.schema';
import { WorkTask, WorkTaskSchema } from './schemas/work-task.schema';
import { TaskLifecycleService } from './task-lifecycle.service';
import { TaskQueryService } from './task-query.service';
import { TaskSyncService } from './task-sync.service';
import { TeamDashboardService } from './team-dashboard.service';
import { WorkAccessService } from './work-access.service';
import { WorkAutomationController } from './work-automation.controller';
import { WorkSchedulerService } from './work-scheduler.service';
import { WorkController } from './work.controller';

// Automatic To-Do & EOD. Additive module: it reads existing CRM / email data
// through RecordReader (no imports of those modules) and never writes to the
// existing DailyReport / /tasks collections.
//
// To add a task source (GorillaDash, Calendar, ...): implement TaskSourceAdapter
// and add it to the SOURCE_ADAPTERS factory below. Nothing else changes.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExternalIdentity.name, schema: ExternalIdentitySchema },
      { name: WorkTask.name, schema: WorkTaskSchema },
      { name: WorkTaskEvent.name, schema: WorkTaskEventSchema },
      { name: WorkSyncRun.name, schema: WorkSyncRunSchema },
      { name: WorkSyncState.name, schema: WorkSyncStateSchema },
      { name: AutomationConfig.name, schema: AutomationConfigSchema },
      { name: EodReport.name, schema: EodReportSchema },
      { name: EodDelivery.name, schema: EodDeliverySchema },
      { name: User.name, schema: UserSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: GmailConnection.name, schema: GmailConnectionSchema },
      { name: OutlookConnection.name, schema: OutlookConnectionSchema },
    ]),
    HttpModule.register({ timeout: 60_000 }),
    AuthModule,
    UsersModule,
    BillingModule,
    MailModule,
  ],
  controllers: [WorkController, WorkAutomationController],
  providers: [
    { provide: RecordReader, useClass: MongoRecordReader },
    CrmTaskAdapter,
    EmailTaskAdapter,
    { provide: GmailActionsSource, useClass: HttpGmailActionsSource },
    GmailTaskAdapter,
    {
      provide: SOURCE_ADAPTERS,
      useFactory: (crm: CrmTaskAdapter, email: EmailTaskAdapter, gmail: GmailTaskAdapter) => [crm, email, gmail],
      inject: [CrmTaskAdapter, EmailTaskAdapter, GmailTaskAdapter],
    },
    IdentityService,
    AutomationConfigService,
    TaskSyncService,
    TaskQueryService,
    TaskLifecycleService,
    WorkAccessService,
    TeamDashboardService,
    EodAiClient,
    EodReportService,
    EodRecipientResolver,
    EodDeliveryService,
    WorkSchedulerService,
  ],
  exports: [IdentityService, TaskSyncService],
})
export class WorkAutomationModule {}
