import { useState } from 'react';
import { FiCloud } from 'react-icons/fi';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui';
import { CloudFilePickerModal } from './CloudFilePickerModal';

export interface CloudPickButtonProps {
  /** Hands over the chosen cloud files as File objects, exactly as if chosen on this computer. */
  onPick: (files: File[]) => void | Promise<void>;
  /** What the page takes (".pdf,.png"), and how large. */
  accept?: string;
  maxBytes?: number;
  multiple?: boolean;
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  disabled?: boolean;
  className?: string;
}

// "From Google Drive or OneDrive" next to a page's own upload: the same picker
// everywhere, and what is picked is fetched through HaiVE and handed to the page's
// existing upload as a copy — the original stays in the cloud.
export function CloudPickButton({
  onPick,
  accept,
  maxBytes,
  multiple = true,
  label = 'From Google Drive or OneDrive',
  size = 'sm',
  variant = 'ghost',
  disabled,
  className,
}: CloudPickButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant={variant} leftIcon={<FiCloud />} disabled={disabled} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <CloudFilePickerModal
        open={open}
        onClose={() => setOpen(false)}
        mode="pick"
        multiple={multiple}
        accept={accept}
        maxBytes={maxBytes}
        title="Choose from Google Drive or OneDrive"
        description="A copy of each file is added here. The original stays where it is."
        onPick={onPick}
      />
    </>
  );
}
