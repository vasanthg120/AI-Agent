import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { VOICE_IDS, VOICE_PERSONALITIES, VoicePersonality } from '../catalog/voice-catalog';

// `null` on a voice/personality field means "clear it" (@IsOptional lets both
// null and undefined through); undefined means "leave it as it is".

export class UpdateVoiceOrganizationDto {
  @IsOptional()
  @IsIn(VOICE_IDS)
  defaultVoiceId?: string | null;

  @IsOptional()
  @IsIn(VOICE_PERSONALITIES)
  defaultPersonality?: VoicePersonality | null;

  @IsOptional()
  @IsBoolean()
  allowUserOverride?: boolean;
}

export class UpdateVoicePreferenceDto {
  @IsOptional()
  @IsIn(VOICE_IDS)
  voiceId?: string | null;

  @IsOptional()
  @IsIn(VOICE_PERSONALITIES)
  personality?: VoicePersonality | null;
}

export class PreviewVoiceDto {
  @IsOptional()
  @IsIn(VOICE_PERSONALITIES)
  personality?: VoicePersonality;
}
