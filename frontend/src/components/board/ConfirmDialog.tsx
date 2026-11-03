import type { ReactNode } from 'react';
import { Button, Modal } from '@/components/ui';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// One confirm/cancel shape for every destructive or save-worthy action
// across the new boards — wraps the existing Modal primitive rather than
// hand-rolling backdrop/escape/focus handling again.
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmLoading,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} description={description} maxWidth={440}>
      {children && <div className={styles.body}>{children}</div>}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={confirmLoading}>
          {cancelLabel}
        </Button>
        <Button type="button" variant={danger ? 'danger' : 'primary'} loading={confirmLoading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
