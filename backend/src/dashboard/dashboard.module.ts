import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ChatModule } from '../chat/chat.module';
import { GamificationModule } from '../gamification/gamification.module';
import { TimelineModule } from '../timeline/timeline.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksExportService } from './tasks-export.service';
import { DailyReport, DailyReportSchema } from './schemas/daily-report.schema';
import { Account, AccountSchema } from '../crm/schemas/account.schema';
import { Contact, ContactSchema } from '../crm/schemas/contact.schema';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteSchema } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';

@Module({
  imports: [
    // Deal/Quote/EmailIntelligenceItem models are registered directly here
    // (read-only lookups in DashboardService, resolving a report task's
    // relatedDealId/relatedQuoteId/relatedEmailId to its real owner) rather
    // than importing CrmModule/EmailIntelligenceModule — CrmModule already
    // imports DashboardModule itself, so importing it back would be a
    // circular module dependency (EmailIntelligenceModule doesn't import
    // DashboardModule, but registering it the same way keeps both consistent
    // and equally zero-coupled). Registering the same schema in a second
    // module is a normal, independent Mongoose/Nest pattern with no coupling
    // to either module's own providers/controllers — no CRM or Email
    // Intelligence file is touched by this.
    MongooseModule.forFeature([
      { name: DailyReport.name, schema: DailyReportSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Quote.name, schema: QuoteSchema },
      { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
      // Additive — TasksService.getEodSummary()'s store-wide "new
      // contacts/accounts today" counts. Same "register the schema
      // directly, don't import the owning module" precedent as the four
      // above (no CrmModule import here — see this module's own comment).
      { name: Contact.name, schema: ContactSchema },
      { name: Account.name, schema: AccountSchema },
    ]),
    // recordDailyReport() calls /reports/generate, which runs a multi-step
    // CrewAI crew (prioritize -> write, each its own LLM call) before
    // structuring the result — chained calls, so it needs at least as much
    // headroom as a single chat turn, not the 30s a one-shot structuring
    // call used to need.
    HttpModule.register({ timeout: 120_000 }),
    AuthModule,
    ChatModule,
    GamificationModule,
    TimelineModule,
    // Reuses ReservationService.reserve/settle/release for the Scheduled
    // Reports crew call — see DashboardService.recordDailyReport's own
    // comment. Cron-triggered (StoreSettingsService.runForAllUsers), so an
    // insufficient-balance org's report is skipped and logged for that run,
    // never blocking the sweep for other orgs — same per-item isolation
    // that loop already has.
    BillingModule,
  ],
  controllers: [DashboardController, TasksController],
  providers: [DashboardService, TasksService, TasksExportService],
  exports: [DashboardService],
})
export class DashboardModule {}
