import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteSchema } from '../crm/schemas/quote.schema';
import { DashboardModule } from '../dashboard/dashboard.module';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TeamActivityModule } from '../team-activity/team-activity.module';
import { TeamScopeModule } from '../team-activity/team-scope.module';
import { AnalyticsDashboardController } from './analytics-dashboard.controller';
import { AnalyticsDashboardService } from './analytics-dashboard.service';
import { BusinessesOverviewService } from './businesses-overview.service';
import { PreviousMonthClosuresService } from './previous-month-closures.service';

// Phase 19 — sits above CrmModule/DashboardModule/EmailIntelligenceModule
// (none of which import it back — no cycle), same shape as
// HomeDashboardModule. OrganizationsModule imported directly (not
// transitively) since CrmModule doesn't re-export it — same reason
// HomeDashboardModule already has to import it itself.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Deal.name, schema: DealSchema },
      { name: Quote.name, schema: QuoteSchema },
    ]),
    AuthModule,
    OrganizationsModule,
    CrmModule,
    DashboardModule,
    EmailIntelligenceModule,
    TeamActivityModule,
    TeamScopeModule,
  ],
  controllers: [AnalyticsDashboardController],
  providers: [AnalyticsDashboardService, PreviousMonthClosuresService, BusinessesOverviewService],
  // Haive's spoken briefing (backend/src/assistant) reads each business's figures from it.
  exports: [BusinessesOverviewService],
})
export class AnalyticsDashboardModule {}
