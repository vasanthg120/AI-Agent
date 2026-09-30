import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CRM_MODULES, CrmModule } from '../provider-catalog';

class TerminologyDto {
  @IsOptional() @IsString() @MaxLength(40) deal?: string;
  @IsOptional() @IsString() @MaxLength(40) quote?: string;
  @IsOptional() @IsString() @MaxLength(40) contact?: string;
  @IsOptional() @IsString() @MaxLength(40) account?: string;
}

class StatusMappingDto {
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) won: string[];
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) lost: string[];
}

class StageMappingDto {
  @IsString() @MaxLength(120) value: string;
  @IsOptional() @IsString() @MaxLength(80) label?: string;
  @IsIn(['open', 'won', 'lost']) category: 'open' | 'won' | 'lost';
}

export class UpdateDataSourceDto {
  @IsOptional() @IsString() @MaxLength(60) label?: string;

  @IsOptional() @IsBoolean() isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(CRM_MODULES, { each: true })
  modules?: CrmModule[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TerminologyDto)
  terminology?: TerminologyDto;

  // { deals: { amount: 'properties.amount', … }, … } — checked field by field
  // against HaiVE's canonical model in DataSourcesService.sanitizeMappings.
  @IsOptional() @IsObject() fieldMappings?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => StatusMappingDto)
  statusMapping?: StatusMappingDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => StageMappingDto)
  stageMappings?: StageMappingDto[];

  @IsOptional() @IsBoolean() syncEnabled?: boolean;

  @IsOptional() @IsNumber() syncIntervalMinutes?: number;
}

export class HiddenMetricsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  hiddenMetrics: string[];
}
