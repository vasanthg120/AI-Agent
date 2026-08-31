import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateBillingSettingsDto {
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsString() companyLogoUrl?: string;
  @IsOptional() @IsString() companyAddress?: string;
  @IsOptional() @IsString() companyEmail?: string;
  @IsOptional() @IsString() companyPhone?: string;
  @IsOptional() @IsString() companyWebsite?: string;
  @IsOptional() @IsString() companyTaxId?: string;
  @IsOptional() @IsString() invoiceNumberPrefix?: string;
  @IsOptional() @IsNumber() @Min(0) invoiceNumberStart?: number;
  @IsOptional() @IsString() invoiceFooterText?: string;
  @IsOptional() @IsString() invoiceTermsText?: string;

  @IsOptional() @IsIn(['razorpay', 'stripe', 'cashfree']) defaultPaymentProvider?: string;
  @IsOptional() @IsIn(['live', 'test']) defaultPaymentMode?: 'live' | 'test';
  @IsOptional() @IsArray() @IsIn(['razorpay', 'stripe', 'cashfree'], { each: true }) enabledGateways?: string[];
  @IsOptional() @IsString() defaultCurrencyCode?: string;
  @IsOptional() @IsNumber() @Min(0) autoRechargeMinCredits?: number;
  @IsOptional() @IsNumber() @Min(0) autoRechargeMaxCredits?: number;
  @IsOptional() @IsBoolean() autoRechargeDefaultOn?: boolean;
}
