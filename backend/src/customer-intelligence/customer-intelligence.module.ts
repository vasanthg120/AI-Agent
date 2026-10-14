import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CustomerDirectoryService } from './customer-directory.service';
import { CustomerJobsController } from './customer-jobs.controller';
import { CustomerJobsService } from './customer-jobs.service';
import { CustomerMailService } from './customer-mail.service';
import { CustomerWorkspaceController } from './customer-workspace.controller';
import { CustomerWorkspaceService } from './customer-workspace.service';
import { CustomersController } from './customers.controller';

// The Customers view: every customer of the organization across its connected
// CRMs and mailbox, each one seen whole (customer-directory.service.ts), and
// what the team attaches to them — comments, tasks, files
// (customer-workspace.service.ts) — and the jobs made from their quotations
// (customer-jobs.service.ts). DataSourcesModule is global.
@Module({
  imports: [HttpModule.register({ timeout: 90_000 }), AuthModule, BillingModule],
  controllers: [CustomersController, CustomerWorkspaceController, CustomerJobsController],
  providers: [CustomerMailService, CustomerDirectoryService, CustomerWorkspaceService, CustomerJobsService, GridFsService],
})
export class CustomerIntelligenceModule {}
