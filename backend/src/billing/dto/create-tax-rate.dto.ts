import { IsBoolean, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateTaxRateDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsNumber()
  @Min(0)
  percentage: number;

  @IsOptional() @IsString() countryCode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsBoolean() inclusive?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
