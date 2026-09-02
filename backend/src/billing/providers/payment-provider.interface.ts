export type PaymentProviderKey = 'razorpay' | 'stripe' | 'cashfree';

export interface GenericWebhookEvent {
  eventId: string;
  event: string; // e.g. 'payment.captured', 'payment.failed' (each adapter normalizes its own gateway's event names to this shape's callers via the same two states: captured/failed)
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  raw: Record<string, unknown>;
}

export interface CreateCheckoutOrderResult {
  orderId: string;
  checkoutParams: Record<string, unknown>;
  simulated: boolean;
}

export interface SaveMethodResult {
  paymentMethodId: string;
  gatewayCustomerId: string;
  gatewayTokenIdEncrypted: string;
  cardLast4: string;
  cardNetwork: string;
}

export interface ChargeResult {
  success: boolean;
  paymentId: string;
  simulated: boolean;
  reason?: string;
}

export interface ConfirmPaymentResult {
  success: boolean;
  reason?: string;
}

export interface RefundResult {
  success: boolean;
  gatewayRefundId?: string;
  simulated: boolean;
  reason?: string;
}

/** Every method the billing domain needs from a payment gateway — the ONE
 * seam every concrete gateway (Razorpay/Stripe/Cashfree — see
 * razorpay-payment.provider.ts, stripe-payment.provider.ts,
 * cashfree-payment.provider.ts) plugs into. Exactly one implementation is
 * bound to the PAYMENT_PROVIDER token at a time, selected by
 * config.billing.activePaymentProvider (see payment-provider.factory.ts) —
 * but all three can be configured (and their webhook routes reachable)
 * simultaneously, e.g. mid-migration between gateways.
 *
 * amount/currency are passed explicitly on every call rather than assumed
 * — currency is config.billing.currency (see PricingService), not
 * hardcoded to any one gateway's native currency.
 *
 * Each adapter independently implements the "unconfigured -> simulate
 * success" fallback (see RazorpayPaymentProvider for the canonical shape)
 * so the whole wallet/reservation/margin pipeline is exercisable in dev
 * without any real gateway credentials, regardless of which is "active". */
export interface PaymentProviderAdapter {
  readonly providerKey: PaymentProviderKey;

  createCustomer(organizationId: string, email: string, name: string): Promise<{ customerId: string }>;

  createCheckoutOrder(
    organizationId: string,
    amount: number,
    currency: string,
    creditPackageKey: string,
  ): Promise<CreateCheckoutOrderResult>;

  // A small, dedicated "authorization" transaction whose sole purpose is to
  // register a chargeable recurring token — NOT a real purchase (the caller
  // refunds it immediately once saveMethodFromCheckout below succeeds; see
  // billing.service.ts's confirmPaymentMethodAuthorization). Distinct from
  // createCheckoutOrder because Razorpay's real "charge without the
  // customer present" flow needs its own order shape (customer_id, a fixed
  // small amount, method restricted to card, a token{} policy block) that a
  // normal purchase/subscription checkout order doesn't carry — confirmed
  // against Razorpay's own docs, see razorpay-payment.provider.ts.
  createAuthorizationOrder(organizationId: string, gatewayCustomerId: string, currency: string): Promise<CreateCheckoutOrderResult>;

  saveMethodFromCheckout(
    organizationId: string,
    gatewayCustomerId: string,
    gatewayPaymentId: string,
    signature: string,
    gatewayOrderId: string,
  ): Promise<SaveMethodResult>;

  chargeSavedMethod(
    organizationId: string,
    gatewayCustomerId: string,
    gatewayTokenId: string,
    amount: number,
    currency: string,
  ): Promise<ChargeResult>;

  // Confirms a just-completed checkout WITHOUT waiting for a webhook — the
  // path used when the app isn't publicly reachable (e.g. local dev behind
  // no tunnel), so a real gateway webhook can never arrive. Each adapter
  // uses whatever native, unspoofable proof its own checkout flow hands
  // back to the browser: Razorpay signs {order_id}|{payment_id} with the
  // key secret (the exact HMAC this interface's implementers already use
  // for saveMethodFromCheckout); Stripe/Cashfree instead re-fetch the
  // payment/order status directly from the gateway's own API rather than
  // trusting anything the client claims — `signature` is unused for those
  // two. Callers (BillingService.confirmPurchase) still only credit once,
  // via an atomic status-guarded update, so this can safely race a webhook
  // that eventually does arrive without double-crediting.
  confirmPayment(gatewayOrderId: string, gatewayPaymentId: string, signature: string): Promise<ConfirmPaymentResult>;

  // Phase 6 — both ids are passed for the same reason confirmPayment takes
  // both: Razorpay/Stripe refund by PAYMENT id, but Cashfree's refund API is
  // scoped to the ORDER id instead (there's no payment-level refund
  // endpoint in its Orders API), so each adapter uses whichever one it
  // actually needs and ignores the other. `amount` is a currency-unit
  // (not minor-unit) value, same convention as createCheckoutOrder/
  // chargeSavedMethod — always <= the original captured amount, enforced by
  // the caller (RefundService), never trusted from this adapter alone.
  refundPayment(gatewayOrderId: string, gatewayPaymentId: string, amount: number, reason?: string): Promise<RefundResult>;

  // `headers` carries whatever else a given gateway's signature scheme
  // needs beyond the raw body + primary signature header — e.g. Cashfree's
  // scheme additionally requires the `x-webhook-timestamp` header.
  // Razorpay/Stripe ignore it (their HMAC only ever covers rawBody).
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string, headers?: Record<string, string>): boolean;

  parseWebhookEvent(rawBody: Buffer): GenericWebhookEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
