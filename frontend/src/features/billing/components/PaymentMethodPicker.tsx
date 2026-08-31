import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiCreditCard } from 'react-icons/fi';
import { Badge, Button, Modal } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { PaymentMethod } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import styles from '../BillingPage.module.css';

export interface PaymentMethodPickerProps {
  paymentMethods: PaymentMethod[];
  onChanged: () => void;
}

// Small, self-contained "which saved card is my default" display + picker —
// factored out of AutoPaySettingsCard's existing Change Payment Method modal
// so the new checkout summary screen can show the same thing without
// touching that component. Picking a different card here only updates which
// one is the default for future use (billingService.setDefaultPaymentMethod,
// already used elsewhere) — it never charges anything itself. The actual
// charge for *this* checkout still happens in the gateway's own widget,
// exactly as before.
export function PaymentMethodPicker({ paymentMethods, onChanged }: PaymentMethodPickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const defaultMethod = paymentMethods.find((m) => m.isDefault) ?? paymentMethods[0];

  const handleSetDefault = async (methodId: string) => {
    setSaving(true);
    try {
      await billingService.setDefaultPaymentMethod(methodId);
      toast.success('Default payment method updated');
      onChanged();
      setOpen(false);
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.checkoutPaymentBox}>
      {defaultMethod ? (
        <div className={styles.paymentMethodRow}>
          <span className={styles.muted}>
            <FiCreditCard style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {defaultMethod.cardNetwork.toUpperCase()} •••• {defaultMethod.cardLast4}
          </span>
          <Badge variant="accent">Default</Badge>
        </div>
      ) : (
        <p className={styles.muted}>You&apos;ll enter your card securely on the next step.</p>
      )}
      {paymentMethods.length > 1 && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Change payment method
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Change Payment Method" description="Choose which saved card to use going forward.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {paymentMethods.map((method) => (
            <div key={method._id} className={styles.paymentMethodRow}>
              <span className={styles.muted}>
                <FiCreditCard style={{ marginRight: 6, verticalAlign: 'middle' }} />
                {method.cardNetwork.toUpperCase()} •••• {method.cardLast4}
              </span>
              {method.isDefault ? (
                <Badge variant="accent">Default</Badge>
              ) : (
                <Button size="sm" variant="secondary" loading={saving} onClick={() => handleSetDefault(method._id)}>
                  Set as Default
                </Button>
              )}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
