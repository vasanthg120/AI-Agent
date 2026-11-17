import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Whose calls: the caller's own (the default), or the team's they may see (TeamScopeService). */
export class CallTeamQueryDto {
  @IsOptional() @IsIn(['mine', 'team']) scope?: 'mine' | 'team';
  // One business, or "all" — the Main Account owner only.
  @IsOptional() @IsString() organizationId?: string;
  // One person of the team.
  @IsOptional() @IsString() userId?: string;
}

export class SearchCallSessionsQueryDto extends CallTeamQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() dealId?: string;
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  // ended (has a summary) / processing / error (couldn't be transcribed).
  @IsOptional() @IsIn(['ended', 'processing', 'error']) status?: 'ended' | 'processing' | 'error';
  // AI Coach score band: good (7+), fair (5–7), low (under 5), none (not scored yet).
  @IsOptional() @IsIn(['good', 'fair', 'low', 'none']) score?: 'good' | 'fair' | 'low' | 'none';

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
