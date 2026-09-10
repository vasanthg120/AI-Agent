import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.module';
import { ChatModule } from './chat/chat.module';
import { DocumentsModule } from './documents/documents.module';
import { CrmModule } from './crm/crm.module';
import { OutlookModule } from './outlook/outlook.module';
import { GmailModule } from './gmail/gmail.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { StoreSettingsModule } from './store-settings/store-settings.module';
import { AgentRolesModule } from './agent-roles/agent-roles.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GamificationModule } from './gamification/gamification.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TimelineModule } from './timeline/timeline.module';
import { CommandCenterModule } from './command-center/command-center.module';
import { FinanceModule } from './finance/finance.module';
import { VoiceModule } from './voice/voice.module';
import { BusinessKnowledgeModule } from './business-knowledge/business-knowledge.module';
import { EmailIntelligenceModule } from './email-intelligence/email-intelligence.module';
import { EmailSlaModule } from './email-sla/email-sla.module';
import { HomeDashboardModule } from './home-dashboard/home-dashboard.module';
import { AnalyticsDashboardModule } from './analytics-dashboard/analytics-dashboard.module';
import { RoyaltyModule } from './royalty/royalty.module';
import { ReportingModule } from './reporting/reporting.module';
import { VendorsModule } from './vendors/vendors.module';
import { BusinessIntelligenceModule } from './business-intelligence/business-intelligence.module';
import { MailModule } from './mail/mail.module';
import { EncryptionModule } from './common/encryption/encryption.module';
import { SessionsModule } from './sessions/sessions.module';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { BillingModule } from './billing/billing.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongoUri'),
      }),
    }),
    ScheduleModule.forRoot(),
    // App-wide default: 60 requests/minute per IP. Per-route overrides via
    // @Throttle() (see AuthController's tighter login/register limit) or
    // @SkipThrottle() (see HealthController).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    EncryptionModule,
    MailModule,
    AuthModule,
    OrganizationsModule,
    UsersModule,
    ChatModule,
    DocumentsModule,
    CrmModule,
    OutlookModule,
    GmailModule,
    IntegrationsModule,
    StoreSettingsModule,
    AgentRolesModule,
    DashboardModule,
    NotificationsModule,
    GamificationModule,
    TimelineModule,
    CommandCenterModule,
    FinanceModule,
    VoiceModule,
    BusinessKnowledgeModule,
    EmailIntelligenceModule,
    EmailSlaModule,
    HomeDashboardModule,
    AnalyticsDashboardModule,
    RoyaltyModule,
    ReportingModule,
    VendorsModule,
    BusinessIntelligenceModule,
    BillingModule,
    // Registers a global audit-logging interceptor (see AuditModule) in
    // addition to its own admin-only GET /audit-logs viewer.
    AuditModule,
    SessionsModule,
    ApiTokensModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
