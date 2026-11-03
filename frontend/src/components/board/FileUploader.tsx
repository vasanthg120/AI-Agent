import type { ReactNode } from 'react';
import { FiUploadCloud } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import { FileDropUpload } from '@/components/common/FileDropUpload';

export interface FileUploaderProps<T> {
  accept: string;
  hint: string;
  // Omit entirely when this record has nowhere to upload to yet — renders
  // the "not connected" state instead of a dropzone that would fail on drop.
  upload?: (file: File) => Promise<T>;
  onUploaded?: (result: T) => void;
  notConnectedMessage?: string;
  notConnectedAction?: ReactNode;
}

// Thin wrapper around the existing FileDropUpload primitive
// (components/common) — adds the same "not connected yet" convention every
// other board shell here uses, so a page can pass `upload={undefined}`
// instead of needing its own conditional around FileDropUpload.
export function FileUploader<T>({ accept, hint, upload, onUploaded, notConnectedMessage, notConnectedAction }: FileUploaderProps<T>) {
  if (!upload || !onUploaded) {
    return (
      <EmptyState
        icon={FiUploadCloud}
        title="Uploads aren't connected here yet"
        description={notConnectedMessage ?? "This record doesn't have its own file storage in HaiVE yet."}
        action={notConnectedAction}
      />
    );
  }
  return <FileDropUpload accept={accept} hint={hint} upload={upload} onUploaded={onUploaded} />;
}
