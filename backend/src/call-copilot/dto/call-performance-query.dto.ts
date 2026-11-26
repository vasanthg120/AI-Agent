import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CallTeamQueryDto } from './search-call-sessions-query.dto';

/** The Performance tab's filters: whose calls (as the Call Library), when, which kind, which score band, which team. */
export class CallPerformanceQueryDto extends CallTeamQueryDto {
  @IsOptional() @IsDateString() dateFrom?: string;
  @IsOptional() @IsDateString() dateTo?: string;
  @IsOptional() @IsIn(['live', 'upload', 'phone']) kind?: 'live' | 'upload' | 'phone';
  // AI Coach score band out of 10: good (7+), fair (5–7), low (under 5).
  @IsOptional() @IsIn(['good', 'fair', 'low']) score?: 'good' | 'fair' | 'low';
  // A team (Settings → Users → Department) within the businesses the caller sees.
  @IsOptional() @IsString() @MaxLength(120) department?: string;

  // The viewer's time zone as minutes east of UTC, so trend days and weeks are theirs.
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(-840)
  @Max(840)
  utcOffsetMinutes?: number;
}
