import { HttpException, HttpStatus } from '@nestjs/common';
import { Connection } from 'mongoose';

// A subscription in one of these states is the business's current one (a
// 'past_due' one is still inside its renewal retries). Same list every billing
// lookup uses; see the unique index on BillingSubscription.
export const LIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due'];

/** Whether a business has a subscription it can work under. */
export async function hasLiveSubscription(connection: Connection, organizationId: string): Promise<boolean> {
  const found = await connection
    .collection('billing_subscriptions')
    .findOne({ organizationId, status: { $in: LIVE_SUBSCRIPTION_STATUSES } }, { projection: { _id: 1 } });
  return !!found;
}

/**
 * What a sub-account with no live subscription is refused with. Only sub-accounts
 * are ever locked: each one pays for itself, while an existing Main Account keeps
 * working exactly as it did whether or not it has a subscription.
 */
export function subscriptionRequired(): HttpException {
  return new HttpException(
    {
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'This account needs an active subscription. Choose a plan in Billing to continue.',
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}
