import { IsOptional, IsString, MinLength } from 'class-validator';

// Mirrors ConfirmPurchaseDto exactly — see that file's comment for why
// `signature` is optional (Razorpay-specific; Stripe/Cashfree confirm by
// re-fetching status from their own API instead).
export class ConfirmSubscriptionDto {
  @IsString()
  @MinLength(1)
  paymentRecordId: string;

  @IsString()
  @MinLength(1)
  gatewayPaymentId: string;

  @IsOptional()
  @IsString()
  signature?: string;
}
