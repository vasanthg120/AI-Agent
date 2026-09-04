import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { BiFilterQueryDto } from './bi-filter-query.dto';

export class ListBiEmailsQueryDto extends BiFilterQueryDto {
  @IsIn(['sent', 'missed', 'replied', 'all'])
  kind: 'sent' | 'missed' | 'replied' | 'all';

  // Narrows to one RELEVANT_EMAIL_INTENTS category (e.g. drilling into the
  // "New Enquiries" stat tile) — invalid/irrelevant values are ignored by
  // buildActivityKindMatch, same permissive behavior listActivity already has.
  @IsOptional()
  @IsString()
  intent?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
