import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateSlaPolicyDto {
  @IsOptional() @IsInt() @Min(1) firstResponseTimeMinutes?: number;
  @IsOptional() @IsBoolean() businessHoursEnabled?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
