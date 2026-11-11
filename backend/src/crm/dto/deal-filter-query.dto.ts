import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Fixed, small vocabularies enforced at this DTO layer, not the Deal schema
// (see deal.schema.ts's comment) — a new category later needs no migration.
export const LEAD_SOURCES = ['referral', 'website', 'cold_call', 'event', 'partner', 'social_media', 'advertisement', 'other'] as const;
export const CUSTOMER_TYPES = ['individual', 'business', 'government', 'other'] as const;
export const REGIONS = ['north', 'south', 'east', 'west', 'central', 'international', 'other'] as const;

// Query params arrive as a single comma-separated string for multi-select
// filters (simpler to round-trip through a saved preset's JSON blob and a
// single React Query key entry than repeated `?x=a&x=b` params).
function splitCsv({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value as string[];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class DealFilterQueryDto {
  // Free-text substring match against Deal.name only (see deal-filter.util.ts
  // — escaped before use in a $regex). Deal has no first-class customer/
  // account name field to search against at the DB layer (a synced deal's
  // real customer signal, when it has one, only exists via a joined Quote's
  // clientDetails, resolved post-query — see deal-owner-mapping.service.ts's
  // listDealsForAssignment).
  @IsOptional()
  @IsString()
  search?: string;

  // Matched against createdAt by default — see dateField below to match
  // expectedClosingDate instead.
  @IsOptional()
  @Matches(DATE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Matches(DATE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo?: string;

  // Which field dateFrom/dateTo range against. Defaults to createdAt (see
  // deal-filter.util.ts). 'expectedClosingDate' exists so a caller can match
  // the period-attribution semantics SalesAnalyticsService.getAchievement
  // uses for the "Total Revenue" figure — a drill-down into that number must
  // filter the same field it was summed over, or the list won't reconcile
  // with the total the user clicked.
  @IsOptional()
  @IsIn(['createdAt', 'expectedClosingDate'])
  dateField?: 'createdAt' | 'expectedClosingDate';

  // Only deals expected to close before this day ("YYYY-MM-DD") — with
  // dealStatus open, the past-due list behind the dashboard's Pipeline Health.
  @IsOptional()
  @Matches(DATE, { message: 'closingBefore must be YYYY-MM-DD' })
  closingBefore?: string;

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsString({ each: true })
  ownerId?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsString({ each: true })
  storeId?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(['open', 'won', 'lost'], { each: true })
  dealStatus?: ('open' | 'won' | 'lost')[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsString({ each: true })
  stageId?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(LEAD_SOURCES, { each: true })
  leadSource?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsString({ each: true })
  product?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(CUSTOMER_TYPES, { each: true })
  customerType?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(REGIONS, { each: true })
  region?: string[];

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  @Min(0)
  valueMin?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  @Min(0)
  valueMax?: number;
}
