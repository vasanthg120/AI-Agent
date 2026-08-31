import { IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

// amount omitted = full refund of whatever remains uncredited (see
// RefundService.refundPayment). Never trust a client-computed amount beyond
// this — the service re-validates it against the PaymentRecord's own
// amount/refundedAmount regardless of what's sent here.
export class CreateRefundDto {
  @IsString()
  @MinLength(1)
  paymentRecordId: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
