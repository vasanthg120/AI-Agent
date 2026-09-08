import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';

export class UpdateBusinessHoursDto {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) workingDays?: number[];
  @IsOptional() @IsString() workingStartTime?: string;
  @IsOptional() @IsString() workingEndTime?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) holidays?: string[];
}
