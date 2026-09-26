import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiFile, FiUploadCloud, FiX } from 'react-icons/fi';
import { Button } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { businessKnowledgeDocumentsService, type BusinessKnowledgeDocument } from '@/services/businessKnowledgeDocumentsService';
import styles from '../business-knowledge.module.css';

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp,.html,.htm,.txt,.md';
const ACCEPTED_SET = new Set(ACCEPTED_EXTENSIONS.split(','));

function isAccepted(file: File): boolean {
  const dot = file.name.lastIndexOf('.');
  return dot >= 0 && ACCEPTED_SET.has(file.name.slice(dot).toLowerCase());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface BusinessKnowledgeDocumentUploadProps {
  onDocumentReady: (doc: BusinessKnowledgeDocument) => void;
}

// Drag-and-drop (or click-to-browse) dropzone → a list of queued files the
// user can prune → sequential upload with a live progress bar. Files are
// still uploaded one at a time, same as before, so each gets its own toast.
export function BusinessKnowledgeDocumentUpload({ onDocumentReady }: BusinessKnowledgeDocumentUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; filename: string } | null>(null);

  const addFiles = (incoming: File[]) => {
    const accepted = incoming.filter(isAccepted);
    const rejected = incoming.length - accepted.length;
    if (rejected > 0) toast.error(`${rejected} file${rejected === 1 ? '' : 's'} skipped — unsupported type`);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...accepted.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        setProgress({ current: i + 1, total: files.length, filename: files[i].name });
        try {
          const doc = await businessKnowledgeDocumentsService.upload(files[i]);
          onDocumentReady(doc);
          toast.success(doc.extractionStatus === 'completed' ? `${files[i].name} processed` : `${files[i].name} uploaded — extraction failed`);
        } catch (err) {
          toast.error(`${files[i].name}: ${extractErrorMessage(err)}`);
        }
      }
    } finally {
      setUploading(false);
      setProgress(null);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className={styles.formGrid}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS}
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
        onClick={() => fileInputRef.current?.click()}
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
        <motion.span className={styles.dropzoneIcon} animate={{ y: dragging ? -4 : 0, scale: dragging ? 1.1 : 1 }}>
          <FiUploadCloud />
        </motion.span>
        <span className={styles.dropzoneTitle}>{dragging ? 'Drop to add' : 'Drag files here, or click to browse'}</span>
        <span className={styles.dropzoneHint}>PDF, Word, PowerPoint, Excel, CSV, images, HTML, text or Markdown</span>
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
            <ul className={styles.queueList}>
              <AnimatePresence initial={false}>
                {files.map((file, i) => {
                  const done = progress !== null && i + 1 < progress.current;
                  const active = progress !== null && i + 1 === progress.current;
                  return (
                    <motion.li
                      key={`${file.name}:${file.size}`}
                      layout
                      className={clsx(styles.queueItem, active && styles.queueItemActive, done && styles.queueItemDone)}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 8 }}
                    >
                      <FiFile className={styles.queueIcon} />
                      <span className={styles.queueName}>{file.name}</span>
                      <span className={styles.queueSize}>{formatSize(file.size)}</span>
                      {!uploading && (
                        <button
                          type="button"
                          className={styles.queueRemove}
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

            <div className={styles.queueActions}>
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
