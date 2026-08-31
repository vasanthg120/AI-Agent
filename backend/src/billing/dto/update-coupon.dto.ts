import { IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { COUPON_APPLIES_TO, CouponAppliesTo } from '../schemas/coupon.schema';

// Hand-written, every field optional — see update-currency.dto.ts's
// identical rationale. `code`/`type` are deliberately absent: immutable
// after creation (changing a coupon's discount shape after it may already
// have been redeemed would make past redemption bookkeeping meaningless).
export class UpdateCouponDto {
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() currencyCode?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(COUPON_APPLIES_TO) appliesTo?: CouponAppliesTo;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicablePlanIds?: string[];

  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string;

  @IsOptional() @IsNumber() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsNumber() @Min(1) maxRedemptionsPerOrg?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
