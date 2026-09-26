import { IsIn, IsString } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from '../../voice/dto/voice-languages';

// Same allow-list the voice feature's own SpeakDto validates against, so a
// language this accepts is always one /voice/speak can then actually speak.
export class VoiceScriptDto {
  @IsString()
  @IsIn(VOICE_LANGUAGE_CODES)
  languageCode: string;
}
