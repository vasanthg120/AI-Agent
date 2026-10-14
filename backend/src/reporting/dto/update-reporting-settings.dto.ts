import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateReportingSettingsDto {
  // The gross margin the organization works to, as a percentage of sales excluding tax. null clears it.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  grossMarginPct?: number | null;
}
