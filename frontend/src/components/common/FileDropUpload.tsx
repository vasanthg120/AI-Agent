import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiFile, FiUploadCloud, FiX } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import styles from './FileDropUpload.module.css';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileDropUploadProps<T> {
  /** Comma-separated extensions, e.g. ".pdf,.png" — also used to reject dropped files of other types. */
  accept: string;
  /** Plain-language list of what can be uploaded, shown under the title. */
  hint: string;
  upload: (file: File) => Promise<T>;
  onUploaded: (result: T) => void;
  /** Toast text for a finished file; defaults to "<name> uploaded". */
  successMessage?: (file: File, result: T) => string;
}

// Drag-and-drop (or click-to-browse) dropzone → a queue the user can prune
// → sequential upload with a live progress bar. Files go up one at a time,
// not in parallel, so a batch never piles up concurrent server-side AI
// extraction calls; each file gets its own toast.
export function FileDropUpload<T>({ accept, hint, upload, onUploaded, successMessage }: FileDropUploadProps<T>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; filename: string } | null>(null);
  const accepted = new Set(accept.split(',').map((e) => e.trim().toLowerCase()));

  const addFiles = (incoming: File[]) => {
    const ok = incoming.filter((f) => {
      const dot = f.name.lastIndexOf('.');
      return dot >= 0 && accepted.has(f.name.slice(dot).toLowerCase());
    });
    const rejected = incoming.length - ok.length;
    if (rejected > 0) toast.error(`${rejected} file${rejected === 1 ? '' : 's'} skipped — unsupported type`);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...ok.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        setProgress({ current: i + 1, total: files.length, filename: files[i].name });
        try {
          const result = await upload(files[i]);
          onUploaded(result);
          toast.success(successMessage ? successMessage(files[i], result) : `${files[i].name} uploaded`);
        } catch (err) {
          toast.error(`${files[i].name}: ${extractErrorMessage(err)}`);
        }
      }
    } finally {
      setUploading(false);
      setProgress(null);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={styles.root}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      <button
        type="button"
        className={clsx(styles.dropzone, dragging && styles.dropzoneActive)}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <motion.span className={styles.icon} animate={{ y: dragging ? -4 : 0, scale: dragging ? 1.1 : 1 }}>
          <FiUploadCloud />
        </motion.span>
        <span className={styles.title}>{dragging ? 'Drop to add' : 'Drag files here, or click to browse'}</span>
        <span className={styles.hint}>{hint}</span>
      </button>

      <AnimatePresence initial={false}>
        {files.length > 0 && (
          <motion.div
            className={styles.queue}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <ul className={styles.list}>
              <AnimatePresence initial={false}>
                {files.map((file, i) => {
                  const done = progress !== null && i + 1 < progress.current;
                  const active = progress !== null && i + 1 === progress.current;
                  return (
                    <motion.li
                      key={`${file.name}:${file.size}`}
                      className={clsx(styles.item, active && styles.itemActive, done && styles.itemDone)}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <FiFile className={styles.itemIcon} />
                      <span className={styles.itemName}>{file.name}</span>
                      <span className={styles.itemSize}>{formatSize(file.size)}</span>
                      {!uploading && (
                        <button
                          type="button"
                          className={styles.itemRemove}
                          aria-label={`Remove ${file.name}`}
                          onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                        >
                          <FiX />
                        </button>
                      )}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>

            {progress && (
              <div className={styles.progress}>
                <div className={styles.progressLabel}>
                  Processing {progress.current} of {progress.total} — {progress.filename}
                </div>
                <div className={styles.progressTrack}>
                  <motion.div
                    className={styles.progressFill}
                    animate={{ width: `${((progress.current - 0.5) / progress.total) * 100}%` }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
              </div>
            )}

            <div className={styles.actions}>
              <Button type="button" variant="ghost" size="sm" disabled={uploading} onClick={() => setFiles([])}>
                Clear
              </Button>
              <Button type="button" size="sm" loading={uploading} disabled={uploading} onClick={() => void handleUpload()}>
                {uploading ? 'Processing…' : `Upload ${files.length} file${files.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
