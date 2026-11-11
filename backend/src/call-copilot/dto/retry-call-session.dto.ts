import { IsIn, IsOptional, IsString } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from '../../voice/dto/voice-languages';

// Only needed for a recording saved before its language was kept on the
// session; a stored language always wins. Same allow-list as the voice feature.
export class RetryCallSessionDto {
  @IsOptional()
  @IsString()
  @IsIn(VOICE_LANGUAGE_CODES)
  languageCode?: string;
}
