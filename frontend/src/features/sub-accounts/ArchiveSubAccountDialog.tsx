import { useEffect, useState } from 'react';
import { Button, Input, Modal } from '@/components/ui';
import styles from './SubAccountsPage.module.css';

export interface ArchiveSubAccountDialogProps {
  name: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typedName: string) => void;
}

// "Delete" is archive: nothing is erased and it can be restored, but sign-in stops
// and it won't renew. Typing the name makes sure this was the account they meant.
export function ArchiveSubAccountDialog({ name, busy, onCancel, onConfirm }: ArchiveSubAccountDialogProps) {
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [name]);

  return (
    <Modal open={!!name} onClose={onCancel} title="Delete this sub-account?" maxWidth={460}>
      <form
        className={styles.dialog}
        onSubmit={(e) => {
          e.preventDefault();
          if (name && typed.trim() === name && !busy) onConfirm(typed.trim());
        }}
      >
        <p className={styles.dialogText}>
          <strong>{name}</strong> will be archived. Nobody can sign in to it, it won’t renew at the end of its paid period,
          and its AI stops at once. Its data is kept, so you can restore it later.
        </p>
        <Input label={`Type “${name ?? ''}” to confirm`} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className={styles.dialogFooter}>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={typed.trim() !== name}>
            Delete sub-account
          </Button>
        </div>
      </form>
    </Modal>
  );
}
