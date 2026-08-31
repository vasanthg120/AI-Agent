import { FiAlertTriangle } from 'react-icons/fi';
import { Button, Card } from '@/components/ui';
import type { SubscriptionSummary, WalletSummary } from '@/services/billingService';
import { formatCurrency } from '@/utils/currency';
import { formatFullDate } from '@/utils/date';
import styles from '../BillingPage.module.css';

export interface CurrentPlanCardProps {
  wallet: WalletSummary;
  subscription: SubscriptionSummary | null;
  onUpgrade: () => void;
  onAddCredits: () => void;
}

// The simplified "at a glance" plan summary — deliberately shows only what a
// customer needs (plan, price, credits remaining, next billing date), never
// the technical/internal fields (gateway, provider, plan key) that the admin
// side works with. Falls back to a plain "no active plan" state rather than
// fabricating a "Free" plan the admin may never have created.
export function CurrentPlanCard({ wallet, subscription, onUpgrade, onAddCredits }: CurrentPlanCardProps) {
  const price = subscription?.price;
  const granted = price?.creditsGranted ?? 0;
  const progressPct = granted > 0 ? Math.max(0, Math.min(100, (wallet.availableCredits / granted) * 100)) : 0;

  return (
    <Card className={styles.currentPlanCard}>
      {subscription && price ? (
        <>
          <div className={styles.currentPlanName}>{subscription.plan?.name ?? 'Current Plan'}</div>
          <div className={styles.currentPlanPrice}>
            {formatCurrency(price.amount, price.currencyCode)} <span className={styles.muted}>/ {price.billingCycle}</span>
          </div>

          <div className={styles.creditsRow}>
            <span>Credits remaining</span>
            <span>
              {wallet.availableCredits.toLocaleString()} / {granted.toLocaleString()}
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
          </div>

          <div className={styles.muted}>Next billing: {formatFullDate(subscription.currentPeriodEnd)}</div>
        </>
      ) : (
        <>
          <div className={styles.currentPlanName}>No active plan</div>
          <p className={styles.muted}>Upgrade to a plan to get recurring Haive Credits every billing cycle.</p>
        </>
      )}

      {wallet.availableCredits <= 0 && (
        <div className={`${styles.banner} ${styles.bannerDanger}`}>
          <span>
            <FiAlertTriangle style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Your Haive Credits are exhausted. Add credits or enable Auto Recharge to continue using Haive AI.
          </span>
        </div>
      )}
      {wallet.availableCredits > 0 && wallet.lowBalance && (
        <div className={`${styles.banner} ${styles.bannerWarning}`}>
          <span>
            Your Haive Credits are running low.{' '}
            {wallet.autoPay.enabled
              ? 'Auto Recharge is enabled and will automatically top up your credits.'
              : 'Add credits to continue using Haive AI without interruption.'}
          </span>
        </div>
      )}

      <div className={styles.currentPlanActions}>
        <Button onClick={onUpgrade}>{subscription ? 'Upgrade Plan' : 'View Plans'}</Button>
        <Button variant="secondary" onClick={onAddCredits}>
          Add Credits
        </Button>
      </div>
    </Card>
  );
}
