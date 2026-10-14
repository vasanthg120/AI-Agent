import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ReportingController } from './reporting.controller';
import { SalesReportService } from './sales-report.service';
import { GrossMarginReportService } from './gross-margin-report.service';
import { QuotationSalesService } from './quotation-sales.service';
import { ReportingSettingsService } from './reporting-settings.service';

// Home for the "Reporting" hub's non-Royalty report types (Sales, Gross
// Margin). Royalty itself stays in RoyaltyModule/its own /royalty/report
// endpoint — this module's controller composes it into one page only on the
// frontend. All three count the same thing — the quotations sent in a
// period, with the value and tax each quotation carries
// (quotation-sales.service.ts) — so no invoice and no cost is read here.
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [ReportingController],
  providers: [SalesReportService, GrossMarginReportService, QuotationSalesService, ReportingSettingsService],
})
export class ReportingModule {}
