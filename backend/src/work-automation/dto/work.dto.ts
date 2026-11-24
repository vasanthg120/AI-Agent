import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class DateQueryDto {
  @IsOptional()
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export class LifecycleActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// Every setting is optional; validation of the values lives in validateConfigPatch.
export class UpdateAutomationConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(5) eodTime?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) enabledSources?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) crmProviders?: string[];
  @IsOptional() @IsInt() staleDealDays?: number;
  @IsOptional() @IsInt() dealCloseWindowDays?: number;
  @IsOptional() @IsInt() quoteDueWindowDays?: number;
  @IsOptional() @IsInt() emailLookbackDays?: number;
  @IsOptional() @IsInt() syncOnLoginMinIntervalMin?: number;
  @IsOptional() @IsBoolean() sendToManager?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) deliveryChannels?: ('gmail' | 'outlook' | 'smtp')[];
  @IsOptional() @IsInt() maxDeliveryAttempts?: number;
}
