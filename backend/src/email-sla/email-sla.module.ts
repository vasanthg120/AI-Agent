import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { EmailSlaController } from './email-sla.controller';
import { EmailSlaService } from './email-sla.service';
import { EmailSlaCalculatorService } from './email-sla-calculator.service';
import { EmailSlaPolicyService } from './email-sla-policy.service';
import { EmailSlaEscalationService } from './email-sla-escalation.service';
import { BusinessHoursConfig, BusinessHoursConfigSchema } from './schemas/business-hours-config.schema';
import { EmailEscalationRule, EmailEscalationRuleSchema } from './schemas/email-escalation-rule.schema';
import { EmailSlaEvent, EmailSlaEventSchema } from './schemas/email-sla-event.schema';
import { EmailSlaPolicy, EmailSlaPolicySchema } from './schemas/email-sla-policy.schema';
import { EmailSlaRecord, EmailSlaRecordSchema } from './schemas/email-sla-record.schema';

// A genuinely isolated extension (see the plan) — email-intelligence.module.ts
// imports THIS module (for EmailSlaService), never the reverse, so there is
// no dependency in either direction on EmailIntelligenceItem/its schema.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailSlaRecord.name, schema: EmailSlaRecordSchema },
      { name: EmailSlaEvent.name, schema: EmailSlaEventSchema },
      { name: EmailSlaPolicy.name, schema: EmailSlaPolicySchema },
      { name: BusinessHoursConfig.name, schema: BusinessHoursConfigSchema },
      { name: EmailEscalationRule.name, schema: EmailEscalationRuleSchema },
    ]),
    NotificationsModule,
    UsersModule,
  ],
  controllers: [EmailSlaController],
  providers: [EmailSlaService, EmailSlaCalculatorService, EmailSlaPolicyService, EmailSlaEscalationService],
  exports: [EmailSlaService],
})
export class EmailSlaModule {}
