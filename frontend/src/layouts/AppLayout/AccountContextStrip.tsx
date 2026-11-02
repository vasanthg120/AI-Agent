import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiAlertTriangle, FiCornerUpLeft } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import styles from './AccountContextStrip.module.css';

// On every page while someone is inside a business other than their own, so a
// change never lands in the wrong one by accident. Also where a sub-account hears
// that its last renewal failed, while there's still time to fix it.
export function AccountContextStrip() {
  const { data, current, home } = useAccounts();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const [switching, setSwitching] = useState(false);

  if (!data || !current) return null;
  const visiting = current.id !== data.homeOrganizationId;
  const paymentFailed = current.accountType === 'sub' && current.subscriptionStatus === 'past_due';
  if (!visiting && !paymentFailed) return null;

  const goHome = async () => {
    setSwitching(true);
    try {
      await switchAccount(data.homeOrganizationId);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setSwitching(false);
    }
  };

  return (
    <div className={styles.stack}>
      {visiting && (
        <div className={styles.visiting} role="status">
          <span className={styles.text}>
            You’re working in <strong>{current.name}</strong>. Changes here only affect this business.
          </span>
          {home && (
            <Button type="button" size="sm" variant="secondary" loading={switching} leftIcon={<FiCornerUpLeft />} onClick={() => void goHome()}>
              Back to {home.accountType === 'main' ? 'Main Account' : home.name}
            </Button>
          )}
        </div>
      )}
      {paymentFailed && (
        <div className={styles.warning} role="alert">
          <FiAlertTriangle aria-hidden />
          <span className={styles.text}>
            The last subscription renewal failed. <Link to={ROUTES.billing}>Check the payment method in Billing</Link> so this
            account stays open.
          </span>
        </div>
      )}
    </div>
  );
}
