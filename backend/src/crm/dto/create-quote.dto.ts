import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { QuoteItemDto } from './quote-item.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// No first-class Customer model exists in this app (confirmed — see
// quote.schema.ts's own clientDetails field) — this mirrors that existing
// subdocument shape exactly rather than inventing a customerId/Customer
// relation.
class QuoteClientDetailsDto {
  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

// Native quote creation — the first real "build a priced quote" entry point
// this app has had. Totals are never accepted here; quotes.service.ts's
// createQuote always recomputes them server-side from `items` via
// quote-pricing.util.ts.
export class CreateQuoteDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteClientDetailsDto)
  clientDetails?: QuoteClientDetailsDto;

  @IsOptional()
  @IsString()
  quoteName?: string;

  @IsOptional()
  @IsString()
  dealId?: string;

  @IsOptional()
  @Matches(DATE, { message: 'expirationDate must be YYYY-MM-DD' })
  expirationDate?: string;

  @IsOptional()
  @Matches(DATE, { message: 'dueDate must be YYYY-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  requestNotes?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'A quote needs at least one line item.' })
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items: QuoteItemDto[];
}

// Exported for update-quote.dto.ts to reuse the same clientDetails shape.
export { QuoteClientDetailsDto };
