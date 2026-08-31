import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

// Body for the "save card" step after a checkout order completes, against
// whichever gateway is currently active (config.billing.activePaymentProvider).
// In simulated mode (that gateway's keys not configured), only
// gatewayCustomerId is meaningful — the payment/signature fields are
// placeholders the provider fills in itself.
export class SavePaymentMethodDto {
  @IsString()
  @MinLength(1)
  gatewayCustomerId: string;

  @IsOptional()
  @IsString()
  gatewayPaymentId?: string;

  @IsOptional()
  @IsString()
  signature?: string;

  @IsOptional()
  @IsString()
  gatewayOrderId?: string;

  // When true, this method becomes the org's default (unsetting any other
  // default) even if it isn't the first one saved — used by the
  // subscription-checkout flow, where the card paying for the plan should
  // always become the Auto Recharge default. Credit-package purchases don't
  // send this, preserving today's "first saved card wins" behavior exactly.
  @IsOptional()
  @IsBoolean()
  makeDefault?: boolean;
}
