import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from '../../voice/dto/voice-languages';

export class ConnectTwilioDto {
  // Account SID from the Twilio console home page: "AC" + 32 hex characters.
  @IsString()
  @Matches(/^AC[0-9a-fA-F]{32}$/, { message: 'The Account SID starts with "AC" followed by 32 letters and digits.' })
  accountSid: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]{32}$/, { message: 'The Auth Token is 32 letters and digits.' })
  authToken: string;
}

export class UpsertTwilioLineDto {
  // A number on the connected Twilio account, in any common format.
  @IsString()
  @MaxLength(32)
  twilioNumber: string;

  @IsString()
  userId: string;

  // That person's real phone, with its country code — Twilio rings it for every call.
  @IsString()
  @MaxLength(32)
  agentPhone: string;

  @IsOptional()
  @IsIn(VOICE_LANGUAGE_CODES)
  languageCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsBoolean()
  announceRecording?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  // Point the number's incoming-call webhook at HaiVE while saving (default on).
  @IsOptional()
  @IsBoolean()
  configureNumber?: boolean;
}
