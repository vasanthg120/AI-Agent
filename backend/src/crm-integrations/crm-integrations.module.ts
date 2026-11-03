import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { MappingIntelligenceService } from '../data-sources/mapping-intelligence.service';
import { GorillaDashModule } from '../gorilladash/gorilladash.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CrmIntegrationsController } from './crm-integrations.controller';
import { CrmIntegrationsService } from './crm-integrations.service';

// The Integrations page's CRM section: provider-aware setup (Pantheras CRM,
// Hoops CRM, Gorilla Dash), status, sync history and field mapping with
// suggestions, preview and versions. DataSourcesModule (global) holds the
// data-source layer and the push webhook this builds on.
@Module({
  imports: [HttpModule.register({ timeout: 120_000 }), AuthModule, BillingModule, IntegrationsModule, GorillaDashModule],
  controllers: [CrmIntegrationsController],
  providers: [CrmIntegrationsService, MappingIntelligenceService],
  // ZohoModule/SalesforceModule inject this to run the same post-connect
  // "read a first page, confirm it works, roll back if not" discovery step
  // every other CRM's connect() already does — their OAuth callback plays
  // the same role connect() plays for gorilladash/prospectconnect, just
  // reached via a provider redirect instead of a form submit.
  exports: [CrmIntegrationsService],
})
export class CrmIntegrationsModule {}
