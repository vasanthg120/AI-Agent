import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { TEAM_PERIODS, TeamPeriod } from '../team-period';
import { CALL_FILTERS, CallFilter, TEAM_LIST_KINDS, TeamListKind } from '../team-activity.service';

export class TeamActivityQueryDto {
  @IsOptional()
  @IsIn(TEAM_PERIODS)
  period?: TeamPeriod;

  // Custom range only: whole business days, "YYYY-MM-DD", both included.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  // One business, or "all" (the Main Account owner only — see TeamScopeService).
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

export class TeamActivityListQueryDto extends TeamActivityQueryDto {
  @IsIn(TEAM_LIST_KINDS)
  kind: TeamListKind;

  // Calls only: made / received / connected / missed / scored.
  @IsOptional()
  @IsIn(CALL_FILTERS)
  callFilter?: CallFilter;
}
