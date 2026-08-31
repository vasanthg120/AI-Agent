import { useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Modal } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { PaymentMethod, PlanPrice, PublicPlan, SubscriptionCheckoutResult } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import { formatCurrency } from '@/utils/currency';
import { PaymentMethodPicker } from './PaymentMethodPicker';
import { HAIVE_LOGO_DATA_URI } from '../haiveLogoDataUri';
import styles from '../BillingPage.module.css';

interface RazorpayCheckoutSuccessResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpayScript(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_SRC;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export interface SubscriptionCheckoutModalProps {
  open: boolean;
  onClose: () => void;
  plan: PublicPlan;
  price: PlanPrice;
  paymentMethods?: PaymentMethod[];
  onPaymentMethodsChanged?: () => void;
  onSubscribed: () => void;
}

// Mirrors RazorpayCheckoutModal's exact gateway-interaction shape (same
// simulated-vs-real branch, same confirmPayment-signature-verification
// discipline) — see that file's comments for why the handler's signature is
// trustworthy — applied to a subscription checkout instead of a credit
// package purchase. Shows a one-screen order summary (plan, total, payment
// method) first; the checkout call + gateway widget only fire once the
// customer clicks Pay, on the exact same code path as before.
export function SubscriptionCheckoutModal({ open, onClose, plan, price, paymentMethods = [], onPaymentMethodsChanged, onSubscribed }: SubscriptionCheckoutModalProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ simulated: boolean } | null>(null);

  const handleClose = () => {
    setResult(null);
    onClose();
  };

  const runCheckout = async () => {
      setLoading(true);
      let order: SubscriptionCheckoutResult;
      try {
        order = await billingService.subscriptionCheckout({ planId: plan.id, priceId: price.id });
      } catch (error) {
        toast.error(extractErrorMessage(error));
        setLoading(false);
        return;
      }

      if (order.activatedImmediately) {
        setResult({ simulated: order.simulated });
        toast.success(`Subscribed to ${plan.name}`);
        onSubscribed();
        setLoading(false);
        return;
      }

      const loaded = await loadRazorpayScript();
      if (!loaded || !window.Razorpay) {
        toast.error("Couldn't load the payment checkout. Please try again.");
        setLoading(false);
        return;
      }

      const razorpay = new window.Razorpay({
        ...order.checkoutParams,
        image: HAIVE_LOGO_DATA_URI,
        handler: async (response: RazorpayCheckoutSuccessResponse) => {
          try {
            await billingService.confirmSubscription({
              paymentRecordId: order.paymentRecordId,
              gatewayPaymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            setResult({ simulated: false });
            toast.success(`Subscribed to ${plan.name}`);
            onSubscribed();

            // The card that paid for the plan becomes the default reusable
            // payment method (makeDefault: true — unlike a credit-package
            // purchase, this one should always become default, not just the
            // org's first saved card), and Auto Recharge turns on
            // automatically so the customer never has to visit this tab
            // manually. Best-effort, same reasoning as
            // RazorpayCheckoutModal.tsx: the subscription itself is already
            // safely active regardless of what happens here.
            try {
              const saved = await billingService.savePaymentMethod({
                gatewayCustomerId: order.orderId,
                gatewayPaymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
                gatewayOrderId: response.razorpay_order_id,
                makeDefault: true,
              });
              const wallet = await billingService.getWallet();
              if (wallet.autoRechargePolicy.defaultOn) {
                await billingService.updateAutoPay({ enabled: true, paymentMethodId: saved._id });
              }
              onSubscribed();
            } catch {
              // No card was saved at checkout (e.g. the shopper didn't tick
              // Razorpay's own "save card" option) — nothing to report.
            }
          } catch (error) {
            toast.error(
              `Payment succeeded but confirming it failed (${extractErrorMessage(error)}) — it will still sync automatically shortly.`,
            );
            onSubscribed();
            handleClose();
          }
        },
      });
      razorpay.open();
      setLoading(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={result ? `Subscribe to ${plan.name}` : 'Checkout'}
      description={result ? undefined : `${formatCurrency(price.amount, price.currencyCode)} / ${price.billingCycle}`}
    >
      {result ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-4) 0' }}>
          <div className={styles.heroValue}>{plan.name}</div>
          <p className={styles.muted}>Your subscription is now active.</p>
          {result.simulated && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Badge variant="warning">Simulated payment — payment gateway not yet configured</Badge>
            </div>
          )}
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div>
            <div className={styles.currentPlanName}>{plan.name}</div>
            <div className={styles.muted}>{price.creditsGranted.toLocaleString()} Haive Credits</div>
          </div>

          <div>
            <div className={styles.checkoutSummaryRow}>
              <span>Plan</span>
              <span>{formatCurrency(price.amount, price.currencyCode)}</span>
            </div>
            <div className={styles.checkoutSummaryTotal}>
              <span>Total</span>
              <span>{formatCurrency(price.amount, price.currencyCode)}</span>
            </div>
          </div>

          <div>
            <span className={styles.fieldLabel}>Payment Method</span>
            <PaymentMethodPicker paymentMethods={paymentMethods} onChanged={() => onPaymentMethodsChanged?.()} />
          </div>

          <Button fullWidth loading={loading} onClick={() => void runCheckout()}>
            Pay {formatCurrency(price.amount, price.currencyCode)}
          </Button>
        </div>
      )}
    </Modal>
  );
}
