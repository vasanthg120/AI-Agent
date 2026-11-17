import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { TeamScopeModule } from '../team-activity/team-scope.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { DealInsightController } from './deal-insight.controller';
import { DealInsightService } from './deal-insight.service';

@Module({
  imports: [HttpModule.register({ timeout: 90_000 }), AuthModule, BillingModule, TeamScopeModule, NotificationsModule, AuditModule],
  controllers: [DealInsightController],
  providers: [DealInsightService],
})
export class DealInsightModule {}
