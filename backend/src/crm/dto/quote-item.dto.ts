import { IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

// Shared by create-quote.dto.ts and update-quote.dto.ts. lineSubtotal/
// lineTotal are deliberately NOT accepted here — those are always
// server-computed (see quote-pricing.util.ts), never trusted from a client,
// per the request's own "backend must be the source of truth" requirement.
export class QuoteItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsString()
  @MinLength(1)
  description: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxRate?: number;
}
