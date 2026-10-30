import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ZohoPayrollController } from './zohopayroll.controller';
import { ZohoPayrollService } from './zohopayroll.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule],
  controllers: [ZohoPayrollController],
  providers: [ZohoPayrollService],
})
export class ZohoPayrollModule {}
