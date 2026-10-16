import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrmIntegrationsModule } from '../crm-integrations/crm-integrations.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SalesforceController } from './salesforce.controller';
import { SalesforceService } from './salesforce.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule, CrmIntegrationsModule],
  controllers: [SalesforceController],
  providers: [SalesforceService],
})
export class SalesforceModule {}
