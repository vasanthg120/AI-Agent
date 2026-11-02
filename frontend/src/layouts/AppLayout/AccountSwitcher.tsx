import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { FiCheck, FiChevronDown, FiSettings } from 'react-icons/fi';
import { ROUTES } from '@/constants/routes';
import { AccountLogo, SubscriptionBadge } from '@/features/sub-accounts/subAccountParts';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { AccountSummary } from '@/services/accountsService';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import styles from './AccountSwitcher.module.css';

const TYPE_LABEL = { main: 'Main Account', sub: 'Sub-Account' } as const;

// Which business is open, and the way into the others this login may enter. Always
// in the header so nobody has to guess whose data they're changing. Someone with
// only one ordinary account doesn't need it, so it stays out of their way.
export function AccountSwitcher() {
  const { data, current } = useAccounts();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, close, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!data || !current) return null;
  const canChoose = data.accounts.length > 1 || data.canManageSubAccounts;
  if (!canChoose && current.accountType !== 'sub') return null;

  const choose = async (account: AccountSummary) => {
    if (account.isCurrent) {
      setOpen(false);
      return;
    }
    setSwitching(account.id);
    try {
      // Reloads the app into that business when it succeeds.
      await switchAccount(account.id);
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setSwitching(null);
    }
  };

  const label = (
    <>
      <AccountLogo name={current.name} logo={current.logo} size="sm" />
      <span className={styles.triggerText}>
        <span className={styles.triggerName}>{current.name}</span>
        <span className={styles.triggerType}>{TYPE_LABEL[current.accountType]}</span>
      </span>
    </>
  );

  if (!canChoose) {
    return (
      <div className={styles.static} data-account-switcher>
        {label}
      </div>
    );
  }

  return (
    <div className={styles.root} ref={rootRef} data-account-switcher>
      <button
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Current account: ${current.name}. Switch account`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <FiChevronDown className={styles.chevron} aria-hidden />
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuTitle}>Switch account</div>
          <ul className={styles.list}>
            {data.accounts.map((account) => {
              const blocked = account.status !== 'active';
              return (
                <li key={account.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={clsx(styles.item, account.isCurrent && styles.itemCurrent)}
                    disabled={blocked || !!switching}
                    title={blocked ? 'This account is suspended' : undefined}
                    onClick={() => void choose(account)}
                  >
                    <AccountLogo name={account.name} logo={account.logo} />
                    <span className={styles.itemText}>
                      <span className={styles.itemName}>{account.name}</span>
                      <span className={styles.itemMeta}>
                        <span>{TYPE_LABEL[account.accountType]}</span>
                        {blocked ? <span className={styles.suspended}>Suspended</span> : <SubscriptionBadge status={account.subscriptionStatus} />}
                      </span>
                    </span>
                    {account.isCurrent && <FiCheck className={styles.check} aria-label="Current account" />}
                    {switching === account.id && <span className={styles.switching}>Switching…</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {data.canManageSubAccounts && (
            <button
              type="button"
              className={styles.manage}
              onClick={() => {
                setOpen(false);
                navigate(ROUTES.settingsSubAccounts);
              }}
            >
              <FiSettings aria-hidden /> Manage sub-accounts
            </button>
          )}
        </div>
      )}
    </div>
  );
}
