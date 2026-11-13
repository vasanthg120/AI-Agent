import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class RecordPaymentDto {
  @IsString()
  @MinLength(1)
  provider: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsISO8601()
  paymentDate: string;

  @IsString()
  @MinLength(1)
  paymentMethod: string;

  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsNumber()
  creditPurchased?: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsNumber()
  taxAmount?: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? Number(value) : value))
  @IsNumber()
  feeAmount?: number;

  @IsOptional()
  @IsIn(['recorded', 'confirmed', 'disputed'])
  status?: 'recorded' | 'confirmed' | 'disputed';

  @IsOptional()
  @IsString()
  notes?: string;
}
