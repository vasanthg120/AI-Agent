import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { XeroController } from './xero.controller';
import { XeroService } from './xero.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule],
  controllers: [XeroController],
  providers: [XeroService],
})
export class XeroModule {}
