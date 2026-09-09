import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [
    AuthModule,
    // Generous timeout — a Sarvam STT/TTS round trip is a real external API
    // call blocking synchronously, same reasoning as finance.module.ts's
    // identical 60s timeout for its own python-agent extraction call.
    HttpModule.register({ timeout: 60_000 }),
  ],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
