import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

// amount is in the smallest currency unit (cents for USD/EUR/GBP, confirmed
// against Square's CreatePayment reference), never a decimal — matches
// Square's own amount_money.amount shape exactly so no rounding conversion
// happens on this side.
export class CreateSquarePaymentDto {
  @IsString()
  @MinLength(1)
  sourceId: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsIn(['USD', 'CAD', 'GBP', 'AUD', 'JPY', 'EUR'])
  currency: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
