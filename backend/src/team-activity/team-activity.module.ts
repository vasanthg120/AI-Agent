import { Module } from '@nestjs/common';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { TeamActivityController } from './team-activity.controller';
import { TeamActivityService } from './team-activity.service';
import { TeamScopeModule } from './team-scope.module';

@Module({
  imports: [EmailIntelligenceModule, TeamScopeModule],
  controllers: [TeamActivityController],
  providers: [TeamActivityService],
})
export class TeamActivityModule {}
