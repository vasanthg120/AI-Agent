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

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DailyReport.name, schema: DailyReportSchema }]),
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
