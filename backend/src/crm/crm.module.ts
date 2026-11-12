import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TimelineModule } from '../timeline/timeline.module';
import { UsersModule } from '../users/users.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { Account, AccountSchema } from './schemas/account.schema';
import { Contact, ContactSchema } from './schemas/contact.schema';
import { CustomerActivitySummary, CustomerActivitySummarySchema } from './schemas/customer-activity-summary.schema';
import {
  CustomerActivityPersonalSummary,
  CustomerActivityPersonalSummarySchema,
} from './schemas/customer-activity-personal-summary.schema';
import { Deal, DealSchema } from './schemas/deal.schema';
import { DealOwnerMapping, DealOwnerMappingSchema } from './schemas/deal-owner-mapping.schema';
import { Decoration, DecorationSchema } from './schemas/decoration.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { Note, NoteSchema } from './schemas/note.schema';
import { Product, ProductSchema } from './schemas/product.schema';
import { Quote, QuoteSchema } from './schemas/quote.schema';
import { CrmActivity, CrmActivitySchema } from './schemas/crm-activity.schema';
import { QuoteCounter, QuoteCounterSchema } from './schemas/quote-counter.schema';
import { QuotePayment, QuotePaymentSchema } from './schemas/quote-payment.schema';
import { SalesTarget, SalesTargetSchema } from './schemas/sales-target.schema';
import { Tag, TagSchema } from './schemas/tag.schema';
import { BusinessDashboardController } from './business-dashboard.controller';
import { BusinessDashboardService } from './business-dashboard.service';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CustomerActivityController } from './customer-activity.controller';
import { CustomerActivityService } from './customer-activity.service';
import { QuotesController } from './quotes.controller';
import { QuoteGuestController } from './quote-guest.controller';
import { QuoteDocumentsService } from './quote-documents.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { DecorationsController } from './decorations.controller';
import { DecorationsService } from './decorations.service';
import { CatalogGridFsService } from './catalog-gridfs.service';
import { QuoteGridFsService } from './quote-gridfs.service';
import { DealPerformanceDashboardService } from './deal-performance-dashboard.service';
import { DealsController } from './deals.controller';
import { DealsExportService } from './deals-export.service';
import { DealsService } from './deals.service';
import { DealOwnerMappingService } from './deal-owner-mapping.service';
import { QuotePaymentsService } from './quote-payments.service';
import { QuotesService } from './quotes.service';
import { CrmActivityService } from './crm-activity.service';
import { SalesAnalyticsService } from './sales-analytics.service';
import { SalesTargetController } from './sales-target.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Contact.name, schema: ContactSchema },
      { name: Account.name, schema: AccountSchema },
      { name: Deal.name, schema: DealSchema },
      { name: DealOwnerMapping.name, schema: DealOwnerMappingSchema },
      { name: Quote.name, schema: QuoteSchema },
      // The CRM activity log (CrmActivityService): every real change to a deal or a quotation.
      { name: CrmActivity.name, schema: CrmActivitySchema },
      // Business Intelligence's Customer Quote & Payment Tracking (QuotePaymentsService,
      // added in a later build phase alongside its write endpoints on QuotesController).
      { name: QuotePayment.name, schema: QuotePaymentSchema },
      { name: Note.name, schema: NoteSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Decoration.name, schema: DecorationSchema },
      { name: Tag.name, schema: TagSchema },
      { name: SalesTarget.name, schema: SalesTargetSchema },
      { name: QuoteCounter.name, schema: QuoteCounterSchema },
      { name: CustomerActivitySummary.name, schema: CustomerActivitySummarySchema },
      { name: CustomerActivityPersonalSummary.name, schema: CustomerActivityPersonalSummarySchema },
      // Read-only reuse of EmailIntelligenceModule's schema class (same
      // precedent as that module's own OutlookConnection/AgentExecution
      // reuse) — BusinessDashboardService's Employee Leaderboard needs
      // sent/missed email counts per user, and CrmModule can never import
      // EmailIntelligenceModule directly (EmailIntelligenceModule -> CrmModule
      // is one-directional, see that module's own comment).
      { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
    ]),
    DashboardModule,
    OrganizationsModule,
    UsersModule,
    AuthModule,
    // Hoops-parity Catalog's vendor picker/validation (Product.vendorId,
    // Decoration.vendorId) — VendorsModule is a leaf module (only
    // Auth/Users/Organizations), so this import is one-directional and safe.
    VendorsModule,
    // SalesBoard's "Job #" column / "View Linked Job" action — one-directional
    // (see customer-intelligence.module.ts's own comment on its CustomerJobsService export).
    CustomerIntelligenceModule,
    // Reuses ReservationService.reserve/settle/release for Customer
    // Activity's "Generate Summary" AI call — see
    // customer-activity.service.ts's own comment.
    BillingModule,
    // Phase 11's Customer Activity summary generation writes a Timeline
    // event on every LLM-generated summary — one-directional import,
    // TimelineModule never imports CrmModule back (see TimelineModule's
    // own comment on why this stays safe from circularity).
    TimelineModule,
    // Calendar reads for teamCalendar/todaysMeetings, and Phase 11's
    // today's-emails + on-demand LLM summary calls, all drive a python-agent
    // round-trip. 60s (not the calendar-only 30s this used to be) — the LLM
    // summary call can retry once internally, same generous timeout as
    // finance.module.ts uses for its own extraction calls.
    HttpModule.register({ timeout: 60_000 }),
  ],
  controllers: [
    CrmController,
    SalesTargetController,
    BusinessDashboardController,
    DealsController,
    CustomerActivityController,
    QuotesController,
    QuoteGuestController,
    ProductsController,
    DecorationsController,
  ],
  providers: [
    CrmActivityService,
    CrmService,
    SalesAnalyticsService,
    BusinessDashboardService,
    DealsService,
    DealsExportService,
    DealOwnerMappingService,
    // DealPerformanceDashboardService has no controller of its own anymore
    // (Deal Performance page removed) — kept as a provider purely because
    // AnalyticsDashboardService injects getConsultantPerformance/
    // getRevenueProgress directly; its own getOverview() method is now dead
    // code (unused, harmless, left in place rather than surgically excised).
    DealPerformanceDashboardService,
    CustomerActivityService,
    QuotesService,
    QuotePaymentsService,
    QuoteDocumentsService,
    ProductsService,
    DecorationsService,
    GridFsService,
    CatalogGridFsService,
    QuoteGridFsService,
  ],
  // Consumed by EmailIntelligenceModule: CustomerActivityService.gatherCorrelationContext
  // (Phase 14b) and QuotesService.createDraftQuote (Phase 14e, post-send actions).
  // BusinessDashboardService (Phase 16) is consumed by the new HomeDashboardModule,
  // which sits above both CrmModule and EmailIntelligenceModule.
  // QuotePaymentsService is consumed by BusinessIntelligenceModule's
  // customer-quote-payment.service.ts for the per-customer payment overlay.
  exports: [
    CrmActivityService,
    CustomerActivityService,
    QuotesService,
    QuotePaymentsService,
    BusinessDashboardService,
    DealPerformanceDashboardService,
    SalesAnalyticsService,
  ],
})
export class CrmModule {}
