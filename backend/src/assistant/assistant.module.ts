import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AnalyticsDashboardModule } from '../analytics-dashboard/analytics-dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ChatModule } from '../chat/chat.module';
import { EmailIntelligenceModule } from '../email-intelligence/email-intelligence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TeamActivityModule } from '../team-activity/team-activity.module';
import { TeamScopeModule } from '../team-activity/team-scope.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { BriefingFactsService } from './briefing-facts.service';
import { ConversationSettingsService } from './conversation-settings.service';
import { ProactiveService } from './proactive.service';

// Haive's voice assistant: the spoken business briefing (facts from the
// business's own data, words from the AI), and the conversation it opens.
@Module({
  imports: [HttpModule.register({ timeout: 60_000 }), AuthModule, BillingModule, ChatModule, AnalyticsDashboardModule, EmailIntelligenceModule, NotificationsModule, TeamActivityModule, TeamScopeModule],
  controllers: [AssistantController],
  providers: [AssistantService, BriefingFactsService, ConversationSettingsService, ProactiveService],
  exports: [AssistantService, BriefingFactsService, ConversationSettingsService],
})
export class AssistantModule {}
