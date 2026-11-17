import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { BUSINESS_LIST_KINDS, BusinessListKind } from '../businesses-overview.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GetBusinessesOverviewQueryDto {
  @Matches(DATE, { message: 'dateFrom must be in "YYYY-MM-DD" format' })
  dateFrom: string;

  @Matches(DATE, { message: 'dateTo must be in "YYYY-MM-DD" format' })
  dateTo: string;
}

export class GetBusinessesListQueryDto extends GetBusinessesOverviewQueryDto {
  @IsIn(BUSINESS_LIST_KINDS)
  kind: BusinessListKind;

  // One business, or every one ('all' or left out). One the caller may not see is refused.
  @IsOptional()
  @IsString()
  organizationId?: string;
}
