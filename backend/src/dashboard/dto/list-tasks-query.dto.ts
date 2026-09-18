import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListTasksQueryDto {
  @IsOptional()
  @IsIn(['todo', 'in_progress', 'done'])
  status?: 'todo' | 'in_progress' | 'done';

  @IsOptional()
  @IsString()
  @Matches(DATE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo?: string;

  // Default (omitted) is true — TasksService.list()/calendarSummary() treat
  // an absent value as "mine", not "everyone's": the caller's own tasks plus
  // any still-unassigned/shared one. Pass mine=false explicitly to see the
  // full shared board (the old default, still available, just no longer
  // automatic) — enforced server-side regardless of what a client sends, so
  // a caller can never see another user's assigned tasks just by omitting
  // this param.
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : value === 'true'))
  @IsBoolean()
  mine?: boolean;
}
