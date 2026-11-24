import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { VOICE_LANGUAGE_CODES } from '../../voice/dto/voice-languages';
import { GREETINGS, MAX_QUESTIONS, MAX_SCHEDULES, STYLES, TIME_PATTERN } from '../conversation-settings';

const TIME_MESSAGE = 'Times are written as HH:mm (24-hour), e.g. 08:30.';

export class ConversationScheduleDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,36}$/i)
  id?: string;

  @IsString()
  @MaxLength(40)
  label!: string;

  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  time!: string;

  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days!: number[];

  @IsBoolean()
  enabled!: boolean;
}

export class ConversationQuestionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  text!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class ConversationMetricsDto {
  @IsOptional() @IsBoolean() revenue?: boolean;
  @IsOptional() @IsBoolean() pipeline?: boolean;
  @IsOptional() @IsBoolean() quotations?: boolean;
  @IsOptional() @IsBoolean() emails?: boolean;
  @IsOptional() @IsBoolean() calls?: boolean;
  @IsOptional() @IsBoolean() tasks?: boolean;
  @IsOptional() @IsBoolean() team?: boolean;
  @IsOptional() @IsBoolean() syncHealth?: boolean;
}

export class ConversationNotifyDto {
  @IsBoolean() bell!: boolean;
  @IsBoolean() phone!: boolean;
}

export class QuietHoursDto {
  @IsBoolean()
  enabled!: boolean;

  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  start!: string;

  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  end!: string;
}

// Any part may be sent alone; what isn't sent stays as it is. Lists (schedules,
// questions) and the small groups (metrics, notify, quietHours) are replaced whole.
export class UpdateConversationSettingsDto {
  @IsOptional() @IsBoolean() voiceEnabled?: boolean;

  @IsOptional() @IsIn(GREETINGS) greeting?: (typeof GREETINGS)[number];

  @IsOptional() @IsIn(VOICE_LANGUAGE_CODES) language?: (typeof VOICE_LANGUAGE_CODES)[number];

  @IsOptional() @IsIn(STYLES) style?: (typeof STYLES)[number];

  @IsOptional() @IsBoolean() briefingEnabled?: boolean;

  // null = the business's own time zone (checked against the real list in the service).
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  timeZone?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULES)
  @ValidateNested({ each: true })
  @Type(() => ConversationScheduleDto)
  schedules?: ConversationScheduleDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => ConversationQuestionDto)
  questions?: ConversationQuestionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ConversationMetricsDto)
  metrics?: ConversationMetricsDto;

  @IsOptional() @IsBoolean() alerts?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConversationNotifyDto)
  notify?: ConversationNotifyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxPerDay?: number;
}
