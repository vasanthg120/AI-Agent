import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { QuoteClientDetailsDto } from './create-quote.dto';
import { QuoteItemDto } from './quote-item.dto';

const QUOTE_CUSTOMER_TYPES = ['new', 'bau'] as const;

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

  // --- Hoops-parity SalesBoard (additive) ---

  @IsOptional()
  @IsString()
  salesStatus?: string;

  @IsOptional()
  @IsString()
  classification?: string;

  @IsOptional()
  @IsString()
  paymentInvoiceStatus?: string;

  @IsOptional()
  @IsString()
  orderStatus?: string;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsString()
  deliveryStatus?: string;

  @IsOptional()
  @IsString()
  artworkStatus?: string;

  @IsOptional()
  @IsString()
  productionReadyStatus?: string;

  @IsOptional()
  @IsString()
  completedStatus?: string;

  @IsOptional()
  @IsString()
  productionHouseVendorId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vendorIds?: string[];

  @IsOptional()
  @IsString()
  decorationId?: string;

  @IsOptional()
  @IsIn(QUOTE_CUSTOMER_TYPES)
  customerType?: string;

  @IsOptional()
  @Matches(DATE, { message: 'deliveryDate must be YYYY-MM-DD' })
  deliveryDate?: string;

  // The reassignable "Owner" — distinct from createdByUserId below, which
  // never changes after creation. Reuses the same real userId shape
  // ownerUserId already had; see quote.schema.ts's comment for why this is
  // safe for Employee Productivity reporting (reassignment makes that
  // report MORE accurate, not less, by reflecting who actually owns the
  // quote today).
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
