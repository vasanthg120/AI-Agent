import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MyobController } from './myob.controller';
import { MyobService } from './myob.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule],
  controllers: [MyobController],
  providers: [MyobService],
})
export class MyobModule {}
