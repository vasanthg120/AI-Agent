import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

// Shared by CreateBillingPlanDto/UpdateBillingPlanDto — mirrors
// BillingPlanFeatureGrant/BillingPlanLimitGrant's embedded-subdocument shape
// exactly (see schemas/billing-plan.schema.ts).
export class BillingPlanFeatureGrantDto {
  @IsString()
  @MinLength(1)
  featureKey: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  valueOverride?: string;
}

export class BillingPlanLimitGrantDto {
  @IsString()
  @MinLength(1)
  limitKey: string;

  @IsOptional()
  @IsBoolean()
  unlimited?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;
}

// Mirrors BillingPlanEntitlementGrant's embedded-subdocument shape (see
// schemas/billing-plan.schema.ts) — Phase 0 of the entitlements migration.
export class BillingPlanEntitlementGrantDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;
}
