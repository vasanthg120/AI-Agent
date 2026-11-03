import type { ReactNode } from 'react';
import { FiDownload, FiFile, FiPaperclip, FiTrash2 } from 'react-icons/fi';
import { EmptyState, IconButton } from '@/components/ui';
import { formatRelativeTime } from '@/utils/date';
import styles from './FilePreview.module.css';

export interface BoardFile {
  id: string;
  name: string;
  size: number;
  uploadedBy: string;
  at: string;
}

export interface FilePreviewProps {
  // Omit when this record has no file storage wired up yet.
  files?: BoardFile[];
  onDownload?: (file: BoardFile) => void;
  onRemove?: (file: BoardFile) => void;
  notConnectedMessage?: string;
  notConnectedAction?: ReactNode;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreview({ files, onDownload, onRemove, notConnectedMessage, notConnectedAction }: FilePreviewProps) {
  if (!files) {
    return (
      <EmptyState
        icon={FiPaperclip}
        title="Files aren't connected here yet"
        description={notConnectedMessage ?? "This record doesn't have its own file storage in HaiVE yet."}
        action={notConnectedAction}
      />
    );
  }
  if (files.length === 0) return <p className={styles.muted}>No files yet.</p>;
  return (
    <ul className={styles.list}>
      {files.map((file) => (
        <li key={file.id} className={styles.item}>
          <FiFile aria-hidden className={styles.icon} />
          <div className={styles.main}>
            <strong>{file.name}</strong>
            <span>
              {formatSize(file.size)} · uploaded by {file.uploadedBy} {formatRelativeTime(file.at)}
            </span>
          </div>
          {onDownload && <IconButton icon={<FiDownload />} label={`Download ${file.name}`} onClick={() => onDownload(file)} />}
          {onRemove && <IconButton icon={<FiTrash2 />} label={`Delete ${file.name}`} onClick={() => onRemove(file)} />}
        </li>
      ))}
    </ul>
  );
}
