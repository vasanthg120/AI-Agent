import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

// Hand-written, every field optional — see update-currency.dto.ts's
// identical rationale. `key` is deliberately absent: immutable after
// creation.
export class UpdateTaxRateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) percentage?: number;
  @IsOptional() @IsString() countryCode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsBoolean() inclusive?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
