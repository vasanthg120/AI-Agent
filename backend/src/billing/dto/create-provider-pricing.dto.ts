import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

// Creates a NEW versioned ProviderPricing row (see that schema's own
// effectiveFrom/effectiveTo comment) — never edits an existing row in place,
// so a price/margin change can never rewrite how a past, already-settled
// transaction was priced. model defaults to '*' (provider-wide default),
// matching every existing ProviderPricing row's own convention.
export class CreateProviderPricingDto {
  @IsString()
  @IsNotEmpty()
  provider: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsNumber()
  @Min(0)
  inputCostPerMTokUsd: number;

  @IsNumber()
  @Min(0)
  outputCostPerMTokUsd: number;

  // 0-100 percentage. Omit to use the global target gross margin
  // (BillingSettings.targetGrossMarginPct / TARGET_GROSS_MARGIN env
  // default) for this provider/model instead of an explicit override.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(99.99)
  marginOverridePct?: number;
}
