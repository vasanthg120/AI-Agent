import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrmIntegrationsModule } from '../crm-integrations/crm-integrations.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ZohoController } from './zoho.controller';
import { ZohoService } from './zoho.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule, CrmIntegrationsModule],
  controllers: [ZohoController],
  providers: [ZohoService],
})
export class ZohoModule {}
