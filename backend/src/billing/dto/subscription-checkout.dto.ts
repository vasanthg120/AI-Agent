import { IsOptional, IsString, MinLength } from 'class-validator';

// planId/priceId are opaque ids only — the server re-resolves the live
// BillingPlan/BillingPlanPrice rows and computes the amount itself
// (see BillingSubscriptionsService.checkout); no price ever comes from the
// request body, same discipline as PurchasePackageDto/BillingService.initiatePurchase.
export class SubscriptionCheckoutDto {
  @IsString()
  @MinLength(1)
  planId: string;

  @IsString()
  @MinLength(1)
  priceId: string;

  // Phase 3 — validated/applied server-side (CouponsService.validate);
  // never trust a client-computed discount.
  @IsOptional()
  @IsString()
  couponCode?: string;
}
