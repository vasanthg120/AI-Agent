import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { BillingPlanEntitlementGrantDto, BillingPlanFeatureGrantDto, BillingPlanLimitGrantDto } from './billing-plan-grant.dto';

// Hand-written, every field optional (no @nestjs/mapped-types dependency in
// this repo — see crm/dto/update-deal.dto.ts's identical rationale). `key`
// is deliberately absent: immutable after creation, same as
// CreditPackage.key.
export class UpdateBillingPlanDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsString() internalDescription?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsString() badgeText?: string;
  @IsOptional() @IsString() badgeColor?: string;
  @IsOptional() @IsString() planColor?: string;

  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isPublic?: boolean;
  @IsOptional() @IsBoolean() recommended?: boolean;
  @IsOptional() @IsInt() @Min(0) trialDays?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BillingPlanFeatureGrantDto)
  features?: BillingPlanFeatureGrantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BillingPlanLimitGrantDto)
  limits?: BillingPlanLimitGrantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BillingPlanEntitlementGrantDto)
  entitlements?: BillingPlanEntitlementGrantDto[];
}
