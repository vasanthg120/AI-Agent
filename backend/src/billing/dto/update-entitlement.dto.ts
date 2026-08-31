import { IsBoolean, IsOptional, IsString } from 'class-validator';

// `type` is deliberately absent — immutable after creation, same reasoning
// as CreditPackage.key/BillingPlan.key (see entitlement.schema.ts's own
// comment on why changing it mid-flight is unsafe).
export class UpdateEntitlementDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
