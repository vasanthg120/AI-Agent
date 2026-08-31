import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiChevronDown, FiChevronUp, FiCreditCard, FiPlus } from 'react-icons/fi';
import { Badge, Button, Input, Modal, Switch } from '@/components/ui';
import { billingService } from '@/services/billingService';
import type { AutoPaySettings, AutoRechargePolicy, PaymentMethod } from '@/services/billingService';
import { extractErrorMessage } from '@/utils/errors';
import { formatCurrency } from '@/utils/currency';
import styles from '../BillingPage.module.css';

export interface AutoPaySettingsCardProps {
  autoPay: AutoPaySettings;
  autoRechargePolicy: AutoRechargePolicy;
  paymentMethods: PaymentMethod[];
  onChanged: () => void;
  // Opens the credit-purchase checkout (owned by BillingPage, alongside
  // this card) — a card can only ever be saved from a real, completed
  // checkout (Razorpay signs it), so "add a payment method" here means
  // "go buy credits and choose to save the card", not a standalone action.
  onRequirePurchase: () => void;
}

// "Auto Recharge" — matches OpenAI's API billing terminology this was
// modeled after: when enabled, Haive automatically charges the default
// saved payment method for the credits actually needed (floored at the
// admin-configured minimum, capped at the admin-configured maximum — see
// AutoPayService.attemptRecharge) once the balance can't cover an
// in-progress request. The recharge amount is never something the customer
// picks here — only the ON/OFF switch and which saved card is the default
// are customer-controlled; the minimum/maximum are set on the Admin Billing
// page (Payment Settings).
export function AutoPaySettingsCard({ autoPay, autoRechargePolicy, paymentMethods, onChanged, onRequirePurchase }: AutoPaySettingsCardProps) {
  const [saving, setSaving] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [changeMethodOpen, setChangeMethodOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [monthlyCap, setMonthlyCap] = useState(autoPay.monthlyCapCredits ? String(autoPay.monthlyCapCredits) : '');

  const defaultMethod = paymentMethods.find((m) => m.isDefault) ?? paymentMethods[0];

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      setConfirmingOff(true);
      return;
    }
    if (!defaultMethod) {
      toast.error('Make a Haive Credits purchase and choose to save your card at checkout, then enable Auto Recharge.');
      onRequirePurchase();
      return;
    }
    setSaving(true);
    try {
      await billingService.updateAutoPay({ enabled: true, paymentMethodId: defaultMethod._id });
      toast.success('Auto Recharge enabled');
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmTurnOff = async () => {
    setSaving(true);
    try {
      await billingService.updateAutoPay({ enabled: false });
      toast.success('Auto Recharge turned off');
      setConfirmingOff(false);
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const saveMonthlyCap = async () => {
    setSaving(true);
    try {
      await billingService.updateAutoPay({
        enabled: autoPay.enabled,
        paymentMethodId: defaultMethod?._id,
        monthlyCapCredits: monthlyCap.trim() ? Number.parseInt(monthlyCap, 10) || 0 : undefined,
      });
      toast.success('Monthly recharge limit saved');
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (methodId: string) => {
    setSaving(true);
    try {
      await billingService.setDefaultPaymentMethod(methodId);
      if (autoPay.enabled) {
        await billingService.updateAutoPay({ enabled: true, paymentMethodId: methodId });
      }
      toast.success('Default payment method updated');
      onChanged();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.autopayGrid}>
      <Switch checked={autoPay.enabled} onChange={setEnabled} label="Auto Recharge" description="Automatically charge your saved payment method when additional credits are required." />

      {autoPay.enabled && (
        <div className={styles.fieldLabel} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Recharge amount</span>
          <span className={styles.muted}>
            {autoRechargePolicy.minCredits
              ? `${formatCurrency(autoRechargePolicy.minCredits, autoRechargePolicy.currency)} minimum`
              : 'Set by your administrator'}
            {autoRechargePolicy.maxCredits ? ` · ${formatCurrency(autoRechargePolicy.maxCredits, autoRechargePolicy.currency)} maximum` : ''}
          </span>
          <span className={styles.muted} style={{ fontSize: 'var(--text-xs)' }}>
            This amount is configured by your administrator, not by you — only enough credits to cover what's needed are ever added, never a flat amount.
          </span>
        </div>
      )}

      <div>
        <span className={styles.fieldLabel}>Payment method</span>
        {defaultMethod ? (
          <div className={styles.paymentMethodRow}>
            <span className={styles.muted}>
              <FiCreditCard style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {defaultMethod.cardNetwork.toUpperCase()} •••• {defaultMethod.cardLast4}
            </span>
            <Badge variant="accent">Default</Badge>
          </div>
        ) : (
          <p className={styles.muted}>
            No payment method on file yet. Make a Haive Credits purchase and choose to save your card at checkout —
            it will then be available for Auto Recharge.
          </p>
        )}
        <Button size="sm" variant="outline" onClick={() => setChangeMethodOpen(true)} style={{ marginTop: 'var(--space-2)' }}>
          Change Payment Method
        </Button>
      </div>

      <div>
        <button
          type="button"
          className={styles.muted}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? <FiChevronUp /> : <FiChevronDown />} Advanced
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
            <Input
              label="Monthly recharge limit (optional)"
              hint="Auto Recharge stops for the rest of the calendar month once this many credits have been added"
              type="number"
              min={0}
              placeholder="No limit"
              value={monthlyCap}
              onChange={(e) => setMonthlyCap(e.target.value)}
            />
            <Button size="sm" loading={saving} onClick={saveMonthlyCap}>
              Save
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={confirmingOff}
        onClose={() => setConfirmingOff(false)}
        title="Turn off Auto Recharge?"
        description="Automatic payments will stop when your Haive Credits are insufficient. Your current plan, credits, and saved payment method will remain unchanged."
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setConfirmingOff(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={saving} onClick={confirmTurnOff}>
            Turn Off
          </Button>
        </div>
      </Modal>

      <Modal open={changeMethodOpen} onClose={() => setChangeMethodOpen(false)} title="Change Payment Method" description="Choose which saved card Auto Recharge should use.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {paymentMethods.length === 0 && <p className={styles.muted}>No cards on file yet.</p>}
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
          <Button
            size="sm"
            variant="outline"
            leftIcon={<FiPlus />}
            onClick={() => {
              setChangeMethodOpen(false);
              onRequirePurchase();
            }}
          >
            Add a new card
          </Button>
        </div>
      </Modal>
    </div>
  );
}
