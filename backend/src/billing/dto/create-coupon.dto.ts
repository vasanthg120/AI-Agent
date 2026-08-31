import { IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { COUPON_APPLIES_TO, COUPON_TYPES, CouponAppliesTo, CouponType } from '../schemas/coupon.schema';

export class CreateCouponDto {
  @IsString()
  @MinLength(1)
  code: string;

  @IsIn(COUPON_TYPES)
  type: CouponType;

  @IsNumber()
  @Min(0)
  value: number;

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
