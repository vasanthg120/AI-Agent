import { Body, Controller, Post, Res, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { SpeakDto } from './dto/speak.dto';
import { VOICE_LANGUAGE_CODES } from './dto/voice-languages';
import { assertVoiceAllowed } from './voice-access';
import { VoiceSpeechService } from './voice-speech.service';
import { VoiceService } from './voice.service';

// No @Roles() gate — matches ChatController's own unrestricted-by-role
// pattern (voice is just an alternate way to send a normal chat message,
// available to whoever can already chat). Throttled the same way
// ChatController throttles /chat/messages, since a transcribe+speak pair is
// a real provider-billed round trip, not a free read.
const VOICE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@UseGuards(JwtAuthGuard)
@Controller('voice')
export class VoiceController {
  constructor(
    private voiceService: VoiceService,
    private speechService: VoiceSpeechService,
  ) {}

  @Post('transcribe')
  @Throttle(VOICE_THROTTLE)
  @UseInterceptors(FileInterceptor('audio', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  transcribe(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body('languageCode') languageCode: string,
  ) {
    assertVoiceAllowed(user);
    if (!file) throw new BadRequestException('No audio file was provided.');
    if (!VOICE_LANGUAGE_CODES.includes(languageCode as (typeof VOICE_LANGUAGE_CODES)[number])) {
      throw new BadRequestException('Selected language is not supported.');
    }
    return this.voiceService.transcribe(user.organizationId, user.sub, file, languageCode);
  }

  // The voice is never chosen here — VoiceSpeechService applies the caller's
  // Voice & Accent configuration, so every feature that speaks gets it.
  @Post('speak')
  @Throttle(VOICE_THROTTLE)
  async speak(@CurrentUser() user: JwtPayload, @Body() dto: SpeakDto, @Res() res: Response) {
    assertVoiceAllowed(user);
    const { audio, contentType } = await this.speechService.speak(user.organizationId, user.sub, dto.text, dto.languageCode);
    // The provider's own type — Sarvam returns WAV, ElevenLabs MP3.
    res.set({ 'Content-Type': contentType });
    res.send(audio);
  }
}
