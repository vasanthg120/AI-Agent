import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { Deal, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteSchema } from '../crm/schemas/quote.schema';
import { Invoice, InvoiceSchema } from './schemas/invoice.schema';
import { InvoiceCounter, InvoiceCounterSchema } from './schemas/invoice-counter.schema';
import { RoyaltyRule, RoyaltyRuleSchema } from './schemas/royalty-rule.schema';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { RoyaltyRulesController } from './royalty-rules.controller';
import { RoyaltyRulesService } from './royalty-rules.service';
import { RoyaltyReportController } from './royalty-report.controller';
import { RoyaltyReportService } from './royalty-report.service';
import { RoyaltyReportExportService } from './royalty-report-export.service';
import { QuotationSalesService } from '../reporting/quotation-sales.service';
import { SalesReportService } from '../reporting/sales-report.service';

// Top-level module, not folded into CrmModule — mirrors FinanceModule's own
// standing as a separate "money" domain despite also being CRM-adjacent.
// Royalty will grow substantially over the future export/AI-enhancement
// sub-phases; this keeps that growth out of the already-large crm.module.ts.
// Deliberately does NOT import CrmModule — dealId/quoteId on Invoice are
// unvalidated free-text refs (matching Deal.contactId's own no-FK-
// validation precedent), and storeId/salespersonId are picked directly by
// the caller, not derived server-side from a live Deal/Quote lookup.
//
// Deal/Quote ARE re-registered here read-only via their own
// MongooseModule.forFeature entries — the same "re-register the schema in a
// second module rather than import the owning module" precedent
// EmailIntelligenceModule already established for OutlookConnection in
// Phase 14b.
//
// The Royalty report counts the quotations sent in a period — the same ones
// the Sales and Gross Margin reports count — so the two small stateless
// services that define and group them (reporting/quotation-sales.service.ts,
// reporting/sales-report.service.ts) are listed in this module's providers
// too, rather than importing ReportingModule for them.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invoice.name, schema: InvoiceSchema },
      { name: InvoiceCounter.name, schema: InvoiceCounterSchema },
      { name: RoyaltyRule.name, schema: RoyaltyRuleSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Quote.name, schema: QuoteSchema },
    ]),
    AuthModule,
    UsersModule,
  ],
  controllers: [InvoicesController, RoyaltyRulesController, RoyaltyReportController],
  providers: [InvoicesService, RoyaltyRulesService, RoyaltyReportService, RoyaltyReportExportService, QuotationSalesService, SalesReportService],
  exports: [InvoicesService, RoyaltyRulesService],
})
export class RoyaltyModule {}
