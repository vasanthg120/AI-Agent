import { IsOptional, IsString, MinLength } from 'class-validator';

export class PurchasePackageDto {
  @IsString()
  @MinLength(1)
  packageKey: string;

  // Phase 3 — validated/applied server-side in BillingService.initiatePurchase
  // (CouponsService.validate); never trust a client-computed discount.
  @IsOptional()
  @IsString()
  couponCode?: string;
}
