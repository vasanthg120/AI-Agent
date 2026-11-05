import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiFile, FiUploadCloud } from 'react-icons/fi';
import { Button, Modal, Spinner } from '@/components/ui';
import { customersService, type ImportCommitResult, type ImportPreviewResult } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './import-customers-modal.module.css';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Hoops-parity "Import" — download the CSV template, upload the completed
// file, preview what would be created (with row-level errors) before
// anything is saved, then commit. Each row goes through the exact same
// createCustomer path the Add Customer form itself uses (see
// customer-import.service.ts's own comment) — never a second,
// import-only way of making a customer.
export function ImportCustomersModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const downloadTemplate = useMutation({
    mutationFn: () => customersService.downloadImportTemplate(),
    onSuccess: (blob) => saveBlob(blob, 'customer-import-template.csv'),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const preview = useMutation<ImportPreviewResult, unknown, File>({
    mutationFn: (chosen) => customersService.previewImport(chosen),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const pickFile = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!chosen.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please choose a .csv file.');
      return;
    }
    if (chosen.size > 10 * 1024 * 1024) {
      toast.error('Maximum file size: 10MB.');
      return;
    }
    setFile(chosen);
    preview.mutate(chosen);
  };

  const commit = useMutation({
    mutationFn: () => customersService.commitImport(file!),
    onSuccess: (res) => {
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const validCount = preview.data?.customers.length ?? 0;
  const errorCount = preview.data?.errors.length ?? 0;

  return (
    <Modal open onClose={onClose} title="Import customers" description="Add customers in bulk from a CSV file." maxWidth={620}>
      {result ? (
        <div className={styles.wizard}>
          <div className={styles.step}>
            <h3>
              <FiCheckCircle /> Import complete
            </h3>
            <div className={styles.summary}>
              <span>{result.created} created</span>
              {result.skippedDuplicates.length > 0 && <span>{result.skippedDuplicates.length} already existed, skipped</span>}
              {result.errors.length > 0 && <span className={styles.previewError}>{result.errors.length} skipped</span>}
            </div>
          </div>
          {(result.skippedDuplicates.length > 0 || result.errors.length > 0) && (
            <div className={styles.previewTable}>
              {result.skippedDuplicates.map((d, i) => (
                <div key={`dup-${i}`} className={styles.previewRow}>
                  <span>Row {d.row}</span>
                  <span>"{d.name}" matches an existing customer — not created.</span>
                </div>
              ))}
              {result.errors.map((e, i) => (
                <div key={`err-${i}`} className={styles.previewRow}>
                  <span>Row {e.row}</span>
                  <span className={styles.previewError}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Button type="button" onClick={onImported}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.wizard}>
          <div className={styles.step}>
            <h3>Step 1</h3>
            <p>Download the template and fill in your customers' details.</p>
            <Button type="button" variant="outline" loading={downloadTemplate.isPending} onClick={() => downloadTemplate.mutate()}>
              Download template
            </Button>
          </div>

          <div className={styles.step}>
            <h3>Step 2</h3>
            <p>Upload the completed CSV file.</p>
            <div
              className={dragging ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files[0]);
              }}
            >
              {file ? (
                <>
                  <FiFile size={28} />
                  <strong>{file.name}</strong>
                </>
              ) : (
                <>
                  <FiUploadCloud size={28} />
                  <strong>Drag and Drop</strong>
                  <span className={styles.hint}>your file here or click to upload</span>
                </>
              )}
              <input ref={inputRef} type="file" accept=".csv" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
            </div>
            <p className={styles.hint}>Recommended file types: .csv. Maximum file size: 10MB.</p>

            {preview.isPending && <Spinner />}
            {preview.data && (
              <>
                <div className={styles.summary}>
                  <span>{validCount} ready to import</span>
                  {errorCount > 0 && <span className={styles.previewError}>{errorCount} row(s) with errors</span>}
                </div>
                <div className={styles.previewTable}>
                  {preview.data.customers.map((c) => (
                    <div key={c.row} className={styles.previewRow}>
                      <span>Row {c.row}</span>
                      <span>{c.summary}</span>
                    </div>
                  ))}
                  {preview.data.errors.map((e, i) => (
                    <div key={i} className={styles.previewRow}>
                      <span>Row {e.row}</span>
                      <span className={styles.previewError}>{e.message}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={commit.isPending}>
              Cancel
            </Button>
            <Button type="button" loading={commit.isPending} disabled={!file || validCount === 0 || preview.isPending} onClick={() => commit.mutate()}>
              Import
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
