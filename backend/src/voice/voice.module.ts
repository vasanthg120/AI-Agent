import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { VoicePreview, VoicePreviewSchema } from './schemas/voice-preview.schema';
import { VoiceConfigController } from './voice-config.controller';
import { VoiceConfigService } from './voice-config.service';
import { VoiceSpeechService } from './voice-speech.service';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [
    AuthModule,
    OrganizationsModule,
    UsersModule,
    AuditModule,
    MongooseModule.forFeature([{ name: VoicePreview.name, schema: VoicePreviewSchema }]),
    // Generous timeout — a Sarvam STT/TTS round trip is a real external API
    // call blocking synchronously, same reasoning as finance.module.ts's
    // identical 60s timeout for its own python-agent extraction call.
    HttpModule.register({ timeout: 60_000 }),
  ],
  controllers: [VoiceController, VoiceConfigController],
  providers: [VoiceService, VoiceConfigService, VoiceSpeechService],
})
export class VoiceModule {}
