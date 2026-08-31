import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { BillingPlanEntitlementGrantDto, BillingPlanFeatureGrantDto, BillingPlanLimitGrantDto } from './billing-plan-grant.dto';

// Admin-only (see billing-admin-plans.controller.ts) — creates a catalog
// entry. Has no price yet: prices are added separately via
// POST /billing/admin/plans/:id/prices (BillingPlanPrice, see that schema
// for why prices are versioned and kept out of this document).
export class CreateBillingPlanDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsString()
  @MinLength(1)
  name: string;

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
