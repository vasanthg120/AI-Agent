import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateInvoiceTemplateDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() showLogo?: boolean;
  @IsOptional() @IsBoolean() showTaxBreakdown?: boolean;
  @IsOptional() @IsString() footerText?: string;
  @IsOptional() @IsString() accentColorHex?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
