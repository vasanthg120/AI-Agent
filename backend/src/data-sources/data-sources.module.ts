import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { DataSourceScopeInterceptor } from './data-source-scope.interceptor';
import { DataSourcesController } from './data-sources.controller';
import { DataSourcesService } from './data-sources.service';
import { DataSource, DataSourceSchema } from './schemas/data-source.schema';
import { WebhookIngestController, WebhookSourcesController } from './webhook-sources.controller';
import { WebhookSourcesService } from './webhook-sources.service';

// CRM data sources: one per connected CRM (plus the HaiVE workspace), each
// with its own mappings, capabilities and sync state, and a request-wide
// scope that keeps every CRM read to the selected source(s). Global so the
// integrations module can reconcile sources when a CRM is (dis)connected.
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: DataSource.name, schema: DataSourceSchema }]), HttpModule.register({ timeout: 30_000 }), AuthModule],
  controllers: [WebhookSourcesController, WebhookIngestController, DataSourcesController],
  providers: [DataSourcesService, WebhookSourcesService, { provide: APP_INTERCEPTOR, useClass: DataSourceScopeInterceptor }],
  exports: [DataSourcesService],
})
export class DataSourcesModule {}
