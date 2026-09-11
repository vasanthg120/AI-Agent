import { Body, Controller, ForbiddenException, Post, Res, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UPLOAD_FILE_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { SpeakDto } from './dto/speak.dto';
import { VOICE_LANGUAGE_CODES } from './dto/voice-languages';
import { VoiceService } from './voice.service';

// No @Roles() gate — matches ChatController's own unrestricted-by-role
// pattern (voice is just an alternate way to send a normal chat message,
// available to whoever can already chat). Throttled the same way
// ChatController throttles /chat/messages, since a transcribe+speak pair is
// a real Sarvam-billed round trip, not a free read.
const VOICE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@UseGuards(JwtAuthGuard)
@Controller('voice')
export class VoiceController {
  constructor(private voiceService: VoiceService) {}

  @Post('transcribe')
  @Throttle(VOICE_THROTTLE)
  @UseInterceptors(FileInterceptor('audio', UPLOAD_FILE_INTERCEPTOR_OPTIONS))
  transcribe(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body('languageCode') languageCode: string,
  ) {
    this.assertVoiceAllowed(user);
    if (!file) throw new BadRequestException('No audio file was provided.');
    if (!VOICE_LANGUAGE_CODES.includes(languageCode as (typeof VOICE_LANGUAGE_CODES)[number])) {
      throw new BadRequestException('Selected language is not supported.');
    }
    return this.voiceService.transcribe(user.organizationId, user.sub, file, languageCode);
  }

  @Post('speak')
  @Throttle(VOICE_THROTTLE)
  async speak(@CurrentUser() user: JwtPayload, @Body() dto: SpeakDto, @Res() res: Response) {
    this.assertVoiceAllowed(user);
    const audio = await this.voiceService.speak(user.organizationId, user.sub, dto.text, dto.languageCode, dto.speaker);
    res.set({ 'Content-Type': 'audio/wav' });
    res.send(audio);
  }

  // Provider/model-availability control, not an AI on/off switch — a user
  // blocked from voice still has full text-chat access via ChatController,
  // which never reads this field. Checked BEFORE any call into voiceService
  // (which is what actually reaches python-agent/Sarvam), so a blocked
  // request never makes an LLM call, never reserves credits, and never
  // deducts anything. user.voiceAccessEnabled is undefined only for
  // special-purpose tokens (2FA challenge, OAuth state) that can't reach
  // this guard anyway (JwtAuthGuard rejects them first); for every real
  // session/API-token request it's always a live boolean refreshed from the
  // User document on this exact request (see JwtStrategy.validate()).
  private assertVoiceAllowed(user: JwtPayload): void {
    if (user.voiceAccessEnabled === false) {
      throw new ForbiddenException('Voice access has been disabled for your account by an administrator.');
    }
  }
}
