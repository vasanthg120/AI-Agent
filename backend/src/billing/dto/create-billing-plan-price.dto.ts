import { IsIn, IsInt, IsNumber, Min, MinLength, IsString } from 'class-validator';
import { BILLING_CYCLES, BillingCycle } from '../schemas/billing-plan-price.schema';

// Admin-only. Creating a new price row never mutates an existing one — see
// schemas/billing-plan-price.schema.ts's effectiveFrom/effectiveTo
// versioning: the service closes out (sets effectiveTo) any prior active
// price for the same (planId, currencyCode, billingCycle) tuple before
// inserting this one, so a change is always additive/historical.
export class CreateBillingPlanPriceDto {
  @IsString()
  @MinLength(1)
  currencyCode: string;

  @IsIn(BILLING_CYCLES)
  billingCycle: BillingCycle;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsInt()
  @Min(0)
  creditsGranted: number;
}
