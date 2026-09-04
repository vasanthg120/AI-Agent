import { IsBoolean, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

// Hand-written, not PartialType — this repo has no @nestjs/mapped-types
// dependency (see update-quote.dto.ts's own comment).
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
