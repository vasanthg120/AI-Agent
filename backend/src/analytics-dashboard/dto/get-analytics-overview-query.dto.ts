import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GetAnalyticsOverviewQueryDto {
  @Matches(DATE, { message: 'dateFrom must be in "YYYY-MM-DD" format' })
  dateFrom: string;

  @Matches(DATE, { message: 'dateTo must be in "YYYY-MM-DD" format' })
  dateTo: string;

  // Owner/admin only — narrows org-wide scope down to one store. Ignored
  // (never trusted) for manager/consultant/agent_user callers, whose scope
  // is always server-derived from their own account.
  @IsOptional()
  @IsString()
  storeId?: string;

  // Owner/admin only — Agent Activity's drill-down: view one specific
  // user's data instead of the org/store aggregate. Same "ignored for
  // non-override callers" rule as storeId above.
  @IsOptional()
  @IsString()
  userId?: string;

  // Agent Activity's team-wide view sets this so every admin-created user
  // is listed, not just manager/consultant (see
  // DealPerformanceDashboardService.getConsultantPerformance). Defaults
  // false so the existing Analytics Dashboard page is unaffected.
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : value === 'true'))
  @IsBoolean()
  includeAllUsers?: boolean;
}
