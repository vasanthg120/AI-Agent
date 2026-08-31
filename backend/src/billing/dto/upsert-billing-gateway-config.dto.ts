import { IsIn, IsObject } from 'class-validator';
import { PaymentProviderKey } from '../providers/payment-provider.interface';

// `credentials` is plaintext in the request body — same trust boundary as
// setting an env var today (admin-only route, expected to run over HTTPS)
// — BillingAdminGatewaysService encrypts every value before persisting and
// this DTO/route never returns a decrypted value back out (see that
// service's toStatus()).
export class UpsertBillingGatewayConfigDto {
  @IsIn(['razorpay', 'stripe', 'cashfree'])
  provider: PaymentProviderKey;

  @IsIn(['live', 'test'])
  mode: 'live' | 'test';

  @IsObject()
  credentials: Record<string, string>;
}
