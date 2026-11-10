import { IsOptional, IsString, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GetPipelineHealthQueryDto {
  @Matches(DATE, { message: 'dateFrom must be in "YYYY-MM-DD" format' })
  dateFrom: string;

  @Matches(DATE, { message: 'dateTo must be in "YYYY-MM-DD" format' })
  dateTo: string;

  // The viewer's own date ("YYYY-MM-DD"), so "past due" means the same as on
  // their screen; the server's date when left out.
  @IsOptional()
  @Matches(DATE, { message: 'today must be in "YYYY-MM-DD" format' })
  today?: string;

  // Owner/admin only — narrows org-wide scope to one store. Ignored for anyone else.
  @IsOptional()
  @IsString()
  storeId?: string;

  // Owner/admin only — one specific user's pipeline. Same rule as storeId.
  @IsOptional()
  @IsString()
  userId?: string;
}
