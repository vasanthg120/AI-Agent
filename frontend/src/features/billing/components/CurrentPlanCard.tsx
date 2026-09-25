import { FiZap } from 'react-icons/fi';
import { Badge, Button, Card } from '@/components/ui';
import type { SubscriptionSummary, WalletSummary } from '@/services/billingService';
import { formatCurrency } from '@/utils/currency';
import { formatFullDate } from '@/utils/date';
import styles from '../BillingPage.module.css';

export interface CurrentPlanCardProps {
  wallet: WalletSummary;
  subscription: SubscriptionSummary | null;
  onUpgrade: () => void;
}

// The simplified "at a glance" plan summary — deliberately shows only what a
// customer needs (plan, price, credits remaining, next billing date), never
// the technical/internal fields (gateway, provider, plan key) that the admin
// side works with. Falls back to a plain "no active plan" state rather than
// fabricating a "Free" plan the admin may never have created. Low-balance/
// exhausted banners live on WalletBalanceCard (the page's hero) instead of
// here, so the two don't both render the same warning.
export function CurrentPlanCard({ wallet, subscription, onUpgrade }: CurrentPlanCardProps) {
  const price = subscription?.price;
  const granted = price?.creditsGranted ?? 0;
  const progressPct = granted > 0 ? Math.max(0, Math.min(100, (wallet.availableCredits / granted) * 100)) : 0;
  const isExhausted = wallet.availableCredits <= 0;
  const progressFillClass = isExhausted
    ? styles.progressFillDanger
    : wallet.lowBalance
      ? styles.progressFillWarning
      : styles.progressFill;

  return (
    <Card className={styles.currentPlanCard}>
      <div className={styles.currentPlanHeader}>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <span className={styles.currentPlanIconBadge}>
            <FiZap size={20} />
          </span>
          <div>
            <div className={styles.currentPlanEyebrow}>
              {subscription ? <Badge variant="accent">Current Plan</Badge> : 'Current Plan'}
            </div>
            <div className={styles.currentPlanName}>{subscription?.plan?.name ?? 'No active plan'}</div>
          </div>
        </div>
        {subscription && price && (
          <div className={styles.currentPlanPrice}>
            {formatCurrency(price.amount, price.currencyCode)}
            <span className={styles.muted}> / {price.billingCycle}</span>
          </div>
        )}
      </div>

      {subscription && price ? (
        <div className={styles.creditsSection}>
          <div className={styles.creditsRow}>
            <span className={styles.creditsRowLabel}>Credits remaining</span>
            <span className={styles.creditsRowValue}>
              {wallet.availableCredits.toLocaleString()} <span className={styles.muted}>/ {granted.toLocaleString()}</span>
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={`${styles.progressFill} ${progressFillClass}`} style={{ width: `${progressPct}%` }} />
          </div>
          <div className={styles.muted}>Next billing: {formatFullDate(subscription.currentPeriodEnd)}</div>
        </div>
      ) : (
        <p className={styles.muted}>Upgrade to a plan to get recurring Haive Credits every billing cycle.</p>
      )}

      <div className={styles.currentPlanActions}>
        <Button onClick={onUpgrade}>{subscription ? 'Upgrade Plan' : 'View Plans'}</Button>
      </div>
    </Card>
  );
}
