import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateCurrencyDto {
  @IsString()
  @MinLength(1)
  code: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  symbol: string;

  @IsOptional() @IsNumber() @Min(0) decimalDigits?: number;
  @IsOptional() @IsIn(['before', 'after']) symbolPosition?: 'before' | 'after';

  @IsNumber()
  @Min(0)
  usdToCurrencyRate: number;

  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
