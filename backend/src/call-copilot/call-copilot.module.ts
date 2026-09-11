import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CallCopilotController } from './call-copilot.controller';
import { CallCopilotGateway } from './call-copilot.gateway';
import { CallCopilotService } from './call-copilot.service';
import { CallSession, CallSessionSchema } from './schemas/call-session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CallSession.name, schema: CallSessionSchema }]),
    // Generous timeout — a Sarvam transcription round trip plus a forced-
    // tool-choice Claude analysis call is real external-API latency, same
    // reasoning as voice.module.ts's identical 60s timeout.
    HttpModule.register({ timeout: 60_000 }),
    AuthModule,
    // Needed for CallCopilotGateway's own session-revocation check on socket
    // connect (mirrors ChatGateway/JwtStrategy's identical check) — no
    // cycle, same precedent ChatModule already documents for this exact import.
    UsersModule,
    // ReservationService — the reserve/settle/release primitive a call
    // session's one whole-call credit hold is built on (see BillingModule's
    // own comment: exported specifically so other AI-backed features adopt
    // this contract instead of reinventing one).
    BillingModule,
  ],
  controllers: [CallCopilotController],
  providers: [CallCopilotService, CallCopilotGateway, GridFsService],
})
export class CallCopilotModule {}
