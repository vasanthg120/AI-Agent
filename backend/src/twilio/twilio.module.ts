import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { CallCopilotModule } from '../call-copilot/call-copilot.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { TwilioCall, TwilioCallSchema } from './schemas/twilio-call.schema';
import { TwilioLine, TwilioLineSchema } from './schemas/twilio-line.schema';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { TwilioWebhooksService } from './twilio-webhooks.service';
import { TwilioController } from './twilio.controller';
import { TwilioService } from './twilio.service';

// Phone calls through Twilio (international numbers) -> recorded -> Call
// Copilot. Twilio's counterpart of PlivoModule: its recordings go through the
// same "Upload a Recording" pipeline, so they get a transcript, a summary and an
// AI Coach report exactly like any other call.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TwilioLine.name, schema: TwilioLineSchema },
      { name: TwilioCall.name, schema: TwilioCallSchema },
    ]),
    HttpModule.register({ timeout: 30_000 }),
    AuthModule,
    UsersModule,
    IntegrationsModule,
    NotificationsModule,
    CallCopilotModule,
  ],
  controllers: [TwilioController, TwilioWebhookController],
  providers: [TwilioService, TwilioWebhooksService],
  exports: [TwilioService, TwilioWebhooksService],
})
export class TwilioModule {}
