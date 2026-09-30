import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GorillaDashController } from './gorilladash.controller';
import { GorillaDashService } from './gorilladash.service';

// Gorilla Dash as a CRM data source (enquiries + people) and for the AI
// agent's Gorilla Dash tools — this module only connects/disconnects it; the
// sync and the tools live in python-agent.
@Module({
  imports: [HttpModule.register({ timeout: 20_000 }), AuthModule, IntegrationsModule],
  controllers: [GorillaDashController],
  providers: [GorillaDashService],
})
export class GorillaDashModule {}
