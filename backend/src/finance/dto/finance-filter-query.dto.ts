import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, Matches, Min } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Small, evolving vocabularies enforced at this DTO layer, not the schema —
// same "no migration needed for a new value" convention as
// deal-filter-query.dto.ts's LEAD_SOURCES/CUSTOMER_TYPES/REGIONS.
export const PAYMENT_STATUSES = ['paid', 'pending', 'overdue', 'partially_paid', 'cancelled'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'credit_card', 'debit_card', 'cheque', 'upi', 'cash', 'other'] as const;

function splitCsv({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value as string[];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class FinanceFilterQueryDto {
  // Matched against invoiceDate — the period-attribution field, same role
  // Deal.expectedClosingDate plays for sales analytics.
  @IsOptional()
  @Matches(DATE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Matches(DATE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo?: string;

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  vendorName?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  department?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  costCenter?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(PAYMENT_STATUSES, { each: true })
  paymentStatus?: (typeof PAYMENT_STATUSES)[number][];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(PAYMENT_METHODS, { each: true })
  paymentMethod?: (typeof PAYMENT_METHODS)[number][];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  expenseCategory?: string[];

  @IsOptional()
  @IsIn(['needs_review', 'reviewed'])
  reviewStatus?: 'needs_review' | 'reviewed';

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  @Min(0)
  amountMin?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  @Min(0)
  amountMax?: number;

  // Linked to a customer quote or not — quote costing lists the unlinked
  // documents that can still be added to a quote.
  @IsOptional()
  @IsIn(['linked', 'unlinked'])
  quoteLink?: 'linked' | 'unlinked';
}
