import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CloudFilesModule } from '../cloud-files/cloud-files.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { Decoration, DecorationSchema } from '../crm/schemas/decoration.schema';
import { IntegrationsModule } from '../integrations/integrations.module';
import { UsersModule } from '../users/users.module';
import { VendorsModule } from '../vendors/vendors.module';
import { XeroModule } from '../xero/xero.module';
import { CustomerCloudSyncController } from './customer-cloud-sync.controller';
import { CustomerCloudSyncService } from './customer-cloud-sync.service';
import { CustomerCloudController } from './customer-cloud.controller';
import { CustomerCloudService } from './customer-cloud.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerImportService } from './customer-import.service';
import { CustomerJobDocumentsService } from './customer-job-documents.service';
import { CustomerJobsController } from './customer-jobs.controller';
import { CustomerJobsService } from './customer-jobs.service';
import { JobGridFsService } from './job-gridfs.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceController } from './customer-workspace.controller';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { CustomersController } from './customers.controller';

// The Customers view: every customer of the organization across its connected
// CRMs and mailbox, each one seen whole (customer-directory.service.ts), and
// what the team attaches to them — comments, tasks, files
// (customer-workspace.service.ts) — and the jobs made from their quotations
// (customer-jobs.service.ts) — and their Google Drive / OneDrive documents
// (customer-cloud.service.ts). DataSourcesModule is global.
@Module({
  imports: [
    HttpModule.register({ timeout: 90_000 }),
    AuthModule,
    BillingModule,
    UsersModule,
    AuditModule,
    CloudFilesModule,
    VendorsModule,
    // JobBoard's "Invoice Status — Xero" (section 11, additive) — read-only
    // use of both; see customer-jobs.service.ts's getXeroInvoiceStatus.
    XeroModule,
    IntegrationsModule,
    // Decoration's own schema, registered a second time (NOT via CrmModule
    // itself — that would be a real cycle, since CrmModule already imports
    // this module for CustomerJobsService) — Mongoose allows the same
    // schema registered through MongooseModule.forFeature in more than one
    // module; each just gets its own injectable Model token for the same
    // underlying collection. Used only to validate JobBoard's "Decoration"
    // field (section 12) belongs to this org, same as every other
    // soft-reference check in this app.
    MongooseModule.forFeature([{ name: Decoration.name, schema: DecorationSchema }]),
  ],
  controllers: [CustomersController, CustomerWorkspaceController, CustomerJobsController, CustomerCloudController, CustomerCloudSyncController],
  providers: [
    CustomerMailService,
    CustomerDirectoryService,
    CustomerWorkspaceService,
    CustomerJobsService,
    CustomerCloudService,
    CustomerCloudSyncService,
    CustomerImportService,
    CustomerJobDocumentsService,
    GridFsService,
    JobGridFsService,
  ],
  // CustomerJobsService: CrmModule's QuotesController reads it for the
  // SalesBoard's "Job #" column / "View Linked Job" action (one-directional
  // — this module never imports CrmModule back, see crm.module.ts's own
  // comment on why that's safe).
  // CustomerDirectoryService: the Dialer's Contacts search (calling/) reads
  // the same directory the Customers page shows.
  exports: [CustomerJobsService, CustomerDirectoryService],
})
export class CustomerIntelligenceModule {}
