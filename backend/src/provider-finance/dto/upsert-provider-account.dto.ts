import { IsArray, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

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
  @IsArray()
  @IsString({ each: true })
  alertRecipients?: string[];
}
