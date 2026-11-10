import { useEffect, useState } from 'react';
import { FiBell, FiChevronDown, FiDownload, FiExternalLink, FiLogOut, FiMoreHorizontal } from '../components/icons';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useAuthStore } from '@/stores/authStore';
import { AccountSheet } from '../components/AccountSheet';
import { Sheet, SheetItem } from '../components/Sheet';
import { promptInstall } from '../lib/install';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { IosInstallSheet, useInstallOffer } from './InstallBits';
import styles from './TopBar.module.css';

/** Which business the calls go out for (and the switch), and the Dialer's menu. */
export function TopBar() {
  const { data, current } = useAccounts();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const installOffer = useInstallOffer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const canSwitch = !!data && data.accounts.length > 1;

  useEffect(() => {
    if (menuOpen) void pushState().then(setPush, () => setPush('unsupported'));
  }, [menuOpen]);

  const togglePush = async () => {
    setPushBusy(true);
    setPushError(null);
    try {
      if (push === 'on') await disablePush();
      else await enablePush();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Couldn’t change notifications.');
    } finally {
      setPush(await pushState().catch(() => 'unsupported' as const));
      setPushBusy(false);
    }
  };
  const pushHint =
    pushError ??
    (push === 'on'
      ? 'On for this phone'
      : push === 'blocked'
        ? 'Blocked in this browser’s settings'
        : push === 'install_first'
          ? 'On iPhone, install the Dialer first'
          : push === 'unsupported'
            ? 'This browser can’t show notifications'
            : 'A notification when the summary and score are in');
  const business = current?.name ?? 'HaiVE';

  return (
    <header className={styles.bar}>
      <img src="/dialer/icons/icon.svg" alt="" width={30} height={30} className={styles.logo} />
      {canSwitch ? (
        <button type="button" className={styles.business} onClick={() => setAccountsOpen(true)} aria-label={`Calling for ${business}. Switch business`}>
          <span className={styles.businessName}>{business}</span>
          <FiChevronDown aria-hidden />
        </button>
      ) : (
        <span className={styles.business}>
          <span className={styles.businessName}>{business}</span>
        </span>
      )}
      <button type="button" className={styles.menuButton} onClick={() => setMenuOpen(true)} aria-label="Menu">
        <FiMoreHorizontal aria-hidden />
      </button>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={user ? `${user.firstName} ${user.lastName}`.trim() || user.email : 'HaiVE Dialer'}>
        {installOffer && (
          <SheetItem
            icon={<FiDownload />}
            label="Install the Dialer"
            hint="Add it to your home screen"
            onClick={() => {
              setMenuOpen(false);
              if (installOffer === 'ios') setIosOpen(true);
              else void promptInstall();
            }}
          />
        )}
        <SheetItem
          icon={<FiBell />}
          label="Tell me when a call report is ready"
          hint={pushHint}
          checked={push === 'on'}
          disabled={pushBusy || push === null || push === 'unsupported' || push === 'install_first' || push === 'blocked'}
          onClick={() => void togglePush()}
        />
        <SheetItem icon={<FiExternalLink />} label="Open HaiVE" hint="The full app: Call Library, settings, everything else" href="/" />
        <SheetItem icon={<FiLogOut />} label="Sign out" danger onClick={() => void logout()} />
      </Sheet>
      <AccountSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} />
      <IosInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
    </header>
  );
}
