import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiLock } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { useAccounts } from './useAccounts';
import styles from './SubscriptionLockScreen.module.css';

// Pages a locked sub-account can still open. The server enforces this; here it
// only decides what to show instead of a page whose every request would be refused.
const OPEN_WHEN_LOCKED = [
  ROUTES.billing,
  ROUTES.pricing,
  ROUTES.addCredits,
  ROUTES.profile,
  ROUTES.notifications,
  ROUTES.help,
  ROUTES.settingsGeneral,
  ROUTES.settingsNotifications,
  ROUTES.settingsSecurity,
  ROUTES.settingsUsers,
];

export function isOpenWhenLocked(pathname: string): boolean {
  return OPEN_WHEN_LOCKED.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

// Shown in place of the page when a sub-account has no live subscription. Its data
// is safe and its team can still sign in; it just has to subscribe to carry on.
export function SubscriptionLockScreen() {
  const { data, current, home } = useAccounts();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const [switching, setSwitching] = useState(false);
  const expired = current?.subscriptionStatus === 'expired' || current?.subscriptionStatus === 'canceled';
  const visiting = !!data && !!current && current.id !== data.homeOrganizationId;

  const goHome = async () => {
    if (!data) return;
    setSwitching(true);
    try {
      await switchAccount(data.homeOrganizationId);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setSwitching(false);
    }
  };

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <span className={styles.icon}>
          <FiLock aria-hidden />
        </span>
        <h1 className={styles.title}>{expired ? 'This subscription has ended' : 'Choose a plan to get started'}</h1>
        <p className={styles.text}>
          {current?.name ?? 'This account'} needs its own active subscription. Everything stays safe until then, and
          Billing and account settings stay open.
        </p>
        <div className={styles.actions}>
          <Link to={ROUTES.pricing} className={styles.primaryLink}>
            Go to Billing
          </Link>
          {visiting && home && (
            <Button type="button" variant="ghost" loading={switching} onClick={() => void goHome()}>
              Back to {home.accountType === 'main' ? 'Main Account' : home.name}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
