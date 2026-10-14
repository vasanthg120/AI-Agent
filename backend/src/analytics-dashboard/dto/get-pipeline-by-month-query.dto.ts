import { IsOptional, IsString } from 'class-validator';

// No dates: the pipeline of every month is asked for at once.
export class GetPipelineByMonthQueryDto {
  // Owner/admin only — narrows org-wide scope down to one store. Ignored
  // (never trusted) for anyone else, whose scope is always server-derived.
  @IsOptional()
  @IsString()
  storeId?: string;

  // Owner/admin only — one specific user's pipeline. Same rule as storeId.
  @IsOptional()
  @IsString()
  userId?: string;
}
