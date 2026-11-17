import { Module } from '@nestjs/common';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TeamActivityController } from './team-activity.controller';
import { TeamActivityService } from './team-activity.service';
import { TeamScopeModule } from './team-scope.module';
import { TeamTasksController } from './team-tasks.controller';

@Module({
  imports: [EmailIntelligenceModule, TeamScopeModule, NotificationsModule],
  controllers: [TeamActivityController, TeamTasksController],
  providers: [TeamActivityService],
  exports: [TeamActivityService],
})
export class TeamActivityModule {}
