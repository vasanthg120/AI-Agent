import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from './voice-languages';

// No voice/speaker field on purpose: which voice speaks is the caller's
// Voice & Accent configuration (voice/voice-config.service.ts), applied
// server-side. A client-supplied provider voice would bypass it.
export class SpeakDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2500)
  text: string;

  @IsString()
  @IsIn(VOICE_LANGUAGE_CODES)
  languageCode: string;
}
