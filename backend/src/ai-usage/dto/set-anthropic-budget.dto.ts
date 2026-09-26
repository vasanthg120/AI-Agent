import { IsIn, IsNumber, IsOptional, Min } from 'class-validator';

export class SetAnthropicBudgetDto {
  @IsNumber()
  @Min(0)
  budgetUsd: number;

  @IsOptional()
  @IsIn(['monthly', 'total'])
  budgetPeriod?: 'monthly' | 'total';
}
