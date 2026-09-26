import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { VOICE_LANGUAGE_CODES } from '../../voice/dto/voice-languages';

export class ConnectPlivoDto {
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  authId: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  authToken: string;
}

export class UpsertPlivoLineDto {
  // The number rented on Plivo, in any common format — normalized to digits
  // with the country code.
  @IsString()
  @MaxLength(32)
  plivoNumber: string;

  // The HaiVE user who takes these calls.
  @IsString()
  userId: string;

  // That person's real phone (e.g. their Airtel SIM) — Plivo rings it for every call.
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
  active?: boolean;
}

export class StartPlivoCallDto {
  @IsString()
  @MaxLength(32)
  customerNumber: string;

  // The deal/customer this call is for — gives the recorded call's session its CRM context.
  @IsOptional()
  @IsString()
  dealId?: string;
}
