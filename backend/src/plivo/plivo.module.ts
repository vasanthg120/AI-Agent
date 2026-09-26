import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { CallCopilotModule } from '../call-copilot/call-copilot.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { PlivoWebhookController } from './plivo-webhook.controller';
import { PlivoWebhooksService } from './plivo-webhooks.service';
import { PlivoController } from './plivo.controller';
import { PlivoService } from './plivo.service';
import { PlivoCall, PlivoCallSchema } from './schemas/plivo-call.schema';
import { PlivoLine, PlivoLineSchema } from './schemas/plivo-line.schema';

// Phone calls through Plivo -> recorded -> Call Copilot. A call recorded by
// Plivo is fetched by its webhook and fed into the same pipeline as "Upload a
// Recording" (CallCopilotUploadService), so it gets a transcript, a summary and
// an AI Coach report exactly like an uploaded file — no second analysis path.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlivoLine.name, schema: PlivoLineSchema },
      { name: PlivoCall.name, schema: PlivoCallSchema },
    ]),
    // Plivo's REST API and the recording download are real network calls.
    HttpModule.register({ timeout: 30_000 }),
    AuthModule,
    UsersModule,
    IntegrationsModule,
    NotificationsModule,
    CallCopilotModule,
  ],
  controllers: [PlivoController, PlivoWebhookController],
  providers: [PlivoService, PlivoWebhooksService],
})
export class PlivoModule {}
