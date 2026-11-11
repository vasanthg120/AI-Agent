import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpsertProviderAccountDto {
  @IsOptional()
  @IsString()
  accountIdentifier?: string;

  @IsOptional()
  @IsIn(['prepaid', 'postpaid', 'usage-limited', 'balance-unavailable'])
  accountType?: 'prepaid' | 'postpaid' | 'usage-limited' | 'balance-unavailable';

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsNumber()
  monthlyBudget?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  lowThresholdPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  criticalThresholdPct?: number;

  @IsOptional()
  @IsIn(['alert-only', 'mark-unavailable'])
  zeroBalanceAction?: 'alert-only' | 'mark-unavailable';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  alertRecipients?: string[];
}
