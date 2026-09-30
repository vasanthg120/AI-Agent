import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ZapierController } from './zapier.controller';
import { ZapierService } from './zapier.service';

// Zapier as a connector for the AI (the apps in the organization's Zapier
// account). Records pushed from Zaps are webhook data sources instead — see
// data-sources/webhook-sources.service.ts.
@Module({
  imports: [HttpModule.register({ timeout: 90_000 }), AuthModule, IntegrationsModule],
  controllers: [ZapierController],
  providers: [ZapierService],
})
export class ZapierModule {}
