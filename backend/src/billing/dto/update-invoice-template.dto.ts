import { IsBoolean, IsOptional, IsString } from 'class-validator';

// Hand-written, every field optional — `key` deliberately absent (immutable
// after creation), same convention as every other admin catalog DTO pair.
export class UpdateInvoiceTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() showLogo?: boolean;
  @IsOptional() @IsBoolean() showTaxBreakdown?: boolean;
  @IsOptional() @IsString() footerText?: string;
  @IsOptional() @IsString() accentColorHex?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
