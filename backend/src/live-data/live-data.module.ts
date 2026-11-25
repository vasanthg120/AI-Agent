import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { TeamScopeModule } from '../team-activity/team-scope.module';
import { LiveDataController } from './live-data.controller';
import { LiveDataService } from './live-data.service';

// Pages show what the connected sources hold now (see live-data.service.ts).
// DataSourcesModule is global.
@Module({
  imports: [HttpModule, AuthModule, TeamScopeModule, CustomerIntelligenceModule, EmailIntelligenceModule],
  controllers: [LiveDataController],
  providers: [LiveDataService],
})
export class LiveDataModule {}
