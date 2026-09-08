import { IsBoolean, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
