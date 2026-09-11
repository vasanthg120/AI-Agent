import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CrmModule } from '../crm/crm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TimelineModule } from '../timeline/timeline.module';
import { UsersModule } from '../users/users.module';
import { VendorsModule } from '../vendors/vendors.module';
import { FinanceDocument, FinanceDocumentSchema } from './schemas/finance-document.schema';
import { FinancePreset, FinancePresetSchema } from './schemas/finance-preset.schema';
import { FinanceSummary, FinanceSummarySchema } from './schemas/finance-summary.schema';
import { FinanceDashboardController } from './finance-dashboard.controller';
import { FinanceDashboardService } from './finance-dashboard.service';
import { FinanceDocumentsController } from './finance-documents.controller';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceExportService } from './finance-export.service';
import { FinanceGridFsService } from './finance-gridfs.service';
import { FinancePresetController } from './finance-preset.controller';
import { FinancePresetService } from './finance-preset.service';
import { FinanceSummaryService } from './finance-summary.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FinanceDocument.name, schema: FinanceDocumentSchema },
      { name: FinancePreset.name, schema: FinancePresetSchema },
      { name: FinanceSummary.name, schema: FinanceSummarySchema },
    ]),
    AuthModule,
    UsersModule,
    NotificationsModule,
    // Reuses ReservationService.reserve/settle/release for the "Generate
    // Summary" AI call — see finance-summary.service.ts's own comment.
    BillingModule,
    // Business Intelligence's Vendor Profitability links FinanceDocument
    // rows to real Vendor master records (see FinanceDocument.vendorRef) —
    // no live consumer of VendorsService here yet, wired ahead for the
    // future "Link to Vendor" control on the document review modal.
    VendorsModule,
    // Vendor Quote <-> Customer Quote linking (FinanceDocument.quoteId/
    // dealId) needs QuotesService to look up/validate a customer quote by
    // number — one-directional import, CrmModule never imports FinanceModule
    // back (same safe-from-circularity precedent as this file's own
    // VendorsModule/TimelineModule imports above).
    CrmModule,
    // Phase 12's on-demand Finance AI summary writes a Timeline event on
    // every LLM-generated summary — same one-directional import as
    // crm.module.ts's identical addition, safe from circularity.
    TimelineModule,
    // Generous timeout — the extraction call blocks on a real Claude
    // vision/PDF call synchronously (see Phase 10a plan notes' sync-vs-async
    // decision), same reasoning as documents.module.ts's own 60s timeout.
    // Also now covers the Phase 12 on-demand summary call.
    HttpModule.register({ timeout: 60_000 }),
  ],
  controllers: [FinanceDocumentsController, FinanceDashboardController, FinancePresetController],
  providers: [
    FinanceDocumentsService,
    GridFsService,
    FinanceGridFsService,
    FinanceExportService,
    FinanceDashboardService,
    FinancePresetService,
    FinanceSummaryService,
  ],
})
export class FinanceModule {}
