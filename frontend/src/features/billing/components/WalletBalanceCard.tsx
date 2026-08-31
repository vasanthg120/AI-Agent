import { FiAlertTriangle, FiCreditCard, FiPlus, FiZap } from 'react-icons/fi';
import { Badge, Button, Card } from '@/components/ui';
import type { WalletSummary } from '@/services/billingService';
import styles from '../BillingPage.module.css';

export interface WalletBalanceCardProps {
  wallet: WalletSummary;
  onAddCredits: () => void;
  onEnableAutoPay: () => void;
  onViewPlans: () => void;
}

// The main balance hero — "Available Credits" in large type, plus the
// low-balance/zero-balance banners the billing spec calls for. Never
// mentions a provider anywhere; "Haive Credits" is the only unit shown.
export function WalletBalanceCard({ wallet, onAddCredits, onEnableAutoPay, onViewPlans }: WalletBalanceCardProps) {
  const isZero = wallet.availableCredits <= 0;

  return (
    <Card className={styles.heroCard}>
      <div>
        <div className={styles.heroLabel}>Available Haive Credits</div>
        <div className={styles.heroValue}>{wallet.availableCredits.toLocaleString()}</div>
        {wallet.reservedCredits > 0 && (
          <div className={styles.heroSub}>{wallet.reservedCredits.toLocaleString()} reserved for in-progress requests</div>
        )}

        {isZero && (
          <div className={`${styles.banner} ${styles.bannerDanger}`} style={{ marginTop: 'var(--space-3)' }}>
            <span>
              <FiAlertTriangle style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Your Haive Credits are exhausted. Add credits or enable Auto Recharge to continue using Haive AI.
            </span>
          </div>
        )}
        {!isZero && wallet.lowBalance && (
          <div className={`${styles.banner} ${styles.bannerWarning}`} style={{ marginTop: 'var(--space-3)' }}>
            <span>
              Your Haive Credits are running low.{' '}
              {wallet.autoPay.enabled
                ? 'Auto Recharge is enabled and will automatically top up your credits.'
                : 'Add credits to continue using Haive AI without interruption.'}
            </span>
          </div>
        )}
      </div>
      <div className={styles.heroActions}>
        <Button variant="secondary" leftIcon={<FiCreditCard />} onClick={onViewPlans}>
          View Plans
        </Button>
        {wallet.autoPay.enabled ? (
          <Button variant="secondary" leftIcon={<FiZap />} onClick={onEnableAutoPay}>
            Auto Recharge{' '}
            <span style={{ marginLeft: 6, display: 'inline-flex' }}>
              <Badge variant="success" dot>
                ON
              </Badge>
            </span>
          </Button>
        ) : (
          <Button variant="secondary" leftIcon={<FiZap />} onClick={onEnableAutoPay}>
            Enable Auto Recharge
          </Button>
        )}
        <Button leftIcon={<FiPlus />} onClick={onAddCredits}>
          Add Credits
        </Button>
      </div>
    </Card>
  );
}
