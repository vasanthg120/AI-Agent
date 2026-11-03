import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteSchema } from '../crm/schemas/quote.schema';
import { DashboardModule } from '../dashboard/dashboard.module';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AnalyticsDashboardController } from './analytics-dashboard.controller';
import { AnalyticsDashboardService } from './analytics-dashboard.service';
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
  ],
  controllers: [AnalyticsDashboardController],
  providers: [AnalyticsDashboardService, PreviousMonthClosuresService],
})
export class AnalyticsDashboardModule {}
