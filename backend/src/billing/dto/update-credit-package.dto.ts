import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

// Hand-written, every field optional — no @nestjs/mapped-types dependency in
// this repo. `key` is deliberately absent: immutable after creation, same
// as Currency.code/BillingPlan.key.
export class UpdateCreditPackageDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() @Min(1) credits?: number;
  @IsOptional() @IsInt() @Min(0) bonusCredits?: number;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
