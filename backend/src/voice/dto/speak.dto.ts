import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from './voice-languages';

export class SpeakDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2500)
  text: string;

  @IsString()
  @IsIn(VOICE_LANGUAGE_CODES)
  languageCode: string;

  @IsOptional()
  @IsString()
  speaker?: string;
}
