import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class UpsertSlaPolicyDto {
  @IsString()
  @MinLength(1)
  priority: string;

  @IsInt()
  @Min(1)
  firstResponseTimeMinutes: number;

  @IsOptional() @IsBoolean() businessHoursEnabled?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
