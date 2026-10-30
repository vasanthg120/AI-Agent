import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ZohoBooksController } from './zohobooks.controller';
import { ZohoBooksService } from './zohobooks.service';

@Module({
  imports: [HttpModule.register({ timeout: 15_000 }), AuthModule, IntegrationsModule],
  controllers: [ZohoBooksController],
  providers: [ZohoBooksService],
})
export class ZohoBooksModule {}
