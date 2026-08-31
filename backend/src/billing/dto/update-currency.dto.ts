import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

// Hand-written, every field optional — no @nestjs/mapped-types dependency
// in this repo (see crm/dto/update-deal.dto.ts's identical rationale).
// `code` is deliberately absent: immutable after creation, same as
// CreditPackage.key/BillingPlan.key.
export class UpdateCurrencyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsNumber() @Min(0) decimalDigits?: number;
  @IsOptional() @IsIn(['before', 'after']) symbolPosition?: 'before' | 'after';
  @IsOptional() @IsNumber() @Min(0) usdToCurrencyRate?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
