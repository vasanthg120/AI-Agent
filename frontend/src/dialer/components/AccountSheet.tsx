import { useState } from 'react';
import toast from 'react-hot-toast';
import { FiBriefcase, FiCheck } from './icons';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useAuthStore } from '@/stores/authStore';
import { extractErrorMessage } from '@/utils/errors';
import { Sheet, SheetItem } from './Sheet';

/** Which business the Dialer is calling for, and the way into the others this login may enter. */
export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useAccounts();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const [switching, setSwitching] = useState<string | null>(null);

  const choose = async (id: string, isCurrent: boolean) => {
    if (isCurrent) return onClose();
    setSwitching(id);
    try {
      // Reloads the Dialer inside that business when it succeeds.
      await switchAccount(id, '/dialer/');
    } catch (err) {
      toast.error(extractErrorMessage(err));
      setSwitching(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Switch business">
      {data?.accounts.map((account) => (
        <SheetItem
          key={account.id}
          icon={account.isCurrent ? <FiCheck /> : <FiBriefcase />}
          label={account.accountType === 'main' ? `${account.name} (Main Account)` : account.name}
          hint={switching === account.id ? 'Switching…' : account.isCurrent ? 'Calling for this business now' : undefined}
          selected={account.isCurrent}
          onClick={() => void choose(account.id, account.isCurrent)}
        />
      ))}
    </Sheet>
  );
}
