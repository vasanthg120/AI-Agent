import { useState } from 'react';
import toast from 'react-hot-toast';
import { Badge, Button, Modal } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { CreditPackage, PaymentMethod } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import { formatCurrency } from '@/utils/currency';
import { CreditPackageGrid } from './CreditPackageGrid';
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

export interface RazorpayCheckoutModalProps {
  open: boolean;
  onClose: () => void;
  packages: CreditPackage[];
  // When set, the modal skips the package-picker grid and opens straight to
  // the order-review/payment screen for this package — used by
  // AddCreditsPage, where picking a package already happened on the page
  // itself (the grid there, not this modal's).
  initialPackage?: CreditPackage;
  paymentMethods?: PaymentMethod[];
  onPaymentMethodsChanged?: () => void;
  onPurchased: () => void;
}

// Purchases must be confirmed by a verified payment before credits are
// permanently granted (see backend/src/billing/billing.service.ts). In
// simulated mode (no Razorpay keys configured on the backend yet) the
// purchase call itself credits the wallet synchronously and this just shows
// the result; once real keys are configured, the same call returns
// simulated:false and this opens the real Razorpay Checkout widget instead
// — crediting then happens only from the verified webhook.
//
// Adds a one-screen order-review step (package, total, payment method)
// between picking a package and actually charging — the charge itself still
// goes through the exact same purchasePackage/confirmPurchase + gateway
// widget flow as before; this only changes when that flow is triggered
// (after "Pay", not immediately on clicking a package card).
export function RazorpayCheckoutModal({ open, onClose, packages, initialPackage, paymentMethods = [], onPaymentMethodsChanged, onPurchased }: RazorpayCheckoutModalProps) {
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(initialPackage ?? null);
  const [purchasingKey, setPurchasingKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ creditsGranted: number; simulated: boolean } | null>(null);

  const handleClose = () => {
    setSelectedPackage(null);
    setResult(null);
    onClose();
  };

  const handlePurchase = async (packageKey: string) => {
    setPurchasingKey(packageKey);
    setResult(null);
    try {
      const order = await billingService.purchasePackage(packageKey);
      if (order.creditedImmediately) {
        const pkg = packages.find((p) => p.key === packageKey);
        setResult({ creditsGranted: (pkg?.credits ?? 0) + (pkg?.bonusCredits ?? 0), simulated: order.simulated });
        toast.success('Haive Credits added to your wallet');
        onPurchased();
        return;
      }

      const loaded = await loadRazorpayScript();
      if (!loaded || !window.Razorpay) {
        toast.error("Couldn't load the payment checkout. Please try again.");
        return;
      }
      const razorpay = new window.Razorpay({
        ...order.checkoutParams,
        // Haive's actual logo — embedded as a data URI rather than a
        // /haive-logo.png URL Checkout.js has to fetch itself, since that
        // fetch was unreliable (showed a fallback "H" avatar instead of the
        // real logo). An inline data URI can't fail to load.
        image: HAIVE_LOGO_DATA_URI,
        // Checkout.js only calls this after Razorpay itself confirms the
        // payment succeeded, and hands back a signature only Razorpay's
        // servers could have produced — confirmPurchase verifies that
        // signature server-side before granting any credit (see
        // billing.service.ts). This is what actually closes the loop when
        // the app isn't publicly reachable for a webhook to arrive on its
        // own; it isn't a weaker "trust the client" shortcut.
        handler: async (response: RazorpayCheckoutSuccessResponse) => {
          try {
            await billingService.confirmPurchase({
              paymentRecordId: order.paymentRecordId,
              gatewayPaymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            });
            const pkg = packages.find((p) => p.key === packageKey);
            setResult({ creditsGranted: (pkg?.credits ?? 0) + (pkg?.bonusCredits ?? 0), simulated: false });
            toast.success('Haive Credits added to your wallet');
            onPurchased();

            // If the shopper checked "save card" in the Razorpay widget,
            // this captures it for future Auto Recharge use. Best-effort:
            // most purchases won't opt in, and that's a normal outcome, not
            // a failure — the credits above are already safely granted
            // regardless of what happens here.
            try {
              await billingService.savePaymentMethod({
                gatewayCustomerId: order.orderId,
                gatewayPaymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
                gatewayOrderId: response.razorpay_order_id,
              });
              toast.success('Card saved for Auto Recharge');
              onPurchased();
            } catch {
              // No card was saved at checkout — nothing to report.
            }
          } catch (error) {
            toast.error(
              `Payment succeeded but confirming it failed (${extractErrorMessage(error)}) — it will still sync automatically shortly.`,
            );
            onPurchased();
            handleClose();
          }
        },
      });
      razorpay.open();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setPurchasingKey(null);
    }
  };

  const totalCredits = selectedPackage ? selectedPackage.credits + selectedPackage.bonusCredits : 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={selectedPackage && !result ? 'Checkout' : 'Add Haive Credits'}
      description={selectedPackage && !result ? undefined : 'Choose a package to add to your wallet.'}
    >
      {result ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-4) 0' }}>
          <div className={styles.heroValue}>+{result.creditsGranted.toLocaleString()}</div>
          <p className={styles.muted}>Haive Credits added to your wallet.</p>
          {result.simulated && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Badge variant="warning">Simulated payment — Razorpay not yet configured</Badge>
            </div>
          )}
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      ) : selectedPackage ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div>
            <div className={styles.currentPlanName}>{selectedPackage.name}</div>
            <div className={styles.muted}>{totalCredits.toLocaleString()} Haive Credits</div>
          </div>

          <div>
            <div className={styles.checkoutSummaryRow}>
              <span>Credits</span>
              <span>{formatCurrency(selectedPackage.price, selectedPackage.currency)}</span>
            </div>
            <div className={styles.checkoutSummaryTotal}>
              <span>Total</span>
              <span>{formatCurrency(selectedPackage.price, selectedPackage.currency)}</span>
            </div>
          </div>

          <div>
            <span className={styles.fieldLabel}>Payment Method</span>
            <PaymentMethodPicker paymentMethods={paymentMethods} onChanged={() => onPaymentMethodsChanged?.()} />
          </div>

          <Button fullWidth loading={purchasingKey === selectedPackage.key} onClick={() => handlePurchase(selectedPackage.key)}>
            Pay {formatCurrency(selectedPackage.price, selectedPackage.currency)}
          </Button>
        </div>
      ) : (
        <CreditPackageGrid packages={packages} purchasingKey={purchasingKey} onPurchase={(key) => setSelectedPackage(packages.find((p) => p.key === key) ?? null)} />
      )}
    </Modal>
  );
}
