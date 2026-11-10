import { useState } from 'react';
import { FiLock, FiRefreshCw, FiWifiOff } from '../components/icons';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useAuthStore } from '@/stores/authStore';
import { AccountSheet } from '../components/AccountSheet';
import { ActionButton, StateScreen } from '../components/StateScreen';

// Signed in, but this account doesn't include Call Copilot (the server would
// refuse every request): say so, and who can change it — not a broken screen.
export function NoAccessScreen() {
  const logout = useAuthStore((state) => state.logout);
  const { data } = useAccounts();
  const [switching, setSwitching] = useState(false);
  return (
    <>
      <StateScreen
        icon={<FiLock />}
        title="Calls aren’t part of your access"
        actions={
          <>
            <ActionButton href="/">Open HaiVE</ActionButton>
            {data && data.accounts.length > 1 && (
              <ActionButton variant="secondary" onClick={() => setSwitching(true)}>
                Switch business
              </ActionButton>
            )}
            <ActionButton variant="secondary" onClick={() => void logout()}>
              Sign out
            </ActionButton>
          </>
        }
      >
        <p>The Dialer is part of Call Copilot, which your account doesn’t include.</p>
        <p>Ask an administrator to give you Call Copilot in Settings → Users.</p>
      </StateScreen>
      <AccountSheet open={switching} onClose={() => setSwitching(false)} />
    </>
  );
}

export function OfflineScreen() {
  return (
    <StateScreen
      icon={<FiWifiOff />}
      title="You’re offline"
      tone="warning"
      actions={
        <ActionButton variant="secondary" onClick={() => window.location.reload()}>
          <FiRefreshCw aria-hidden /> Try again
        </ActionButton>
      }
    >
      <p>Calls and your call reports need the internet. The Dialer reconnects by itself as soon as you’re back online.</p>
    </StateScreen>
  );
}
