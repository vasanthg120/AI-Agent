import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { DecorationPriceBreakDto } from './decoration-price-break.dto';

export class UpdateDecorationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  vendorId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  setupCost?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DecorationPriceBreakDto)
  priceBreaks?: DecorationPriceBreakDto[];
}
