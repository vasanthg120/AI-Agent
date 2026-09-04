import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { QuoteClientDetailsDto } from './create-quote.dto';
import { QuoteItemDto } from './quote-item.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Hand-written, not PartialType (this repo has no @nestjs/mapped-types
// dependency — see update-deal.dto.ts's own comment). quoteAmount/
// clientApprovalStatus/quoteStatus are all still editable at the DTO layer
// — the synced-quote guard that rejects them for externalId-bearing quotes
// lives in quotes.service.ts's updateQuote, not here, since a native
// (non-synced) quote must still be able to edit these same fields.
export class UpdateQuoteDto {
  @IsOptional()
  @IsString()
  quoteName?: string;

  @IsOptional()
  @IsString()
  quoteStatus?: string;

  @IsOptional()
  @IsString()
  clientApprovalStatus?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quoteAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @Matches(DATE, { message: 'expirationDate must be YYYY-MM-DD' })
  expirationDate?: string;

  @IsOptional()
  @Matches(DATE, { message: 'dueDate must be YYYY-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  requestNotes?: string;

  @IsOptional()
  @IsString()
  dealId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteClientDetailsDto)
  clientDetails?: QuoteClientDetailsDto;

  // When present, quotes.service.ts's updateQuote re-validates and
  // recalculates subtotal/discountAmount/taxAmount/quoteAmount from these —
  // the client-sent items are never trusted as-is, matching createQuote's
  // own convention (see quote-pricing.util.ts).
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'A quote needs at least one line item.' })
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items?: QuoteItemDto[];
}
