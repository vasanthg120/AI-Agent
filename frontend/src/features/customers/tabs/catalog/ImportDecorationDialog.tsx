import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiFile, FiUploadCloud } from 'react-icons/fi';
import { Button, Modal, Spinner } from '@/components/ui';
import { decorationsService, type ImportCommitResult, type ImportPreviewResult } from '@/services/decorationsService';
import type { VendorOption } from '@/services/vendorsService';
import { extractErrorMessage } from '@/utils/errors';
import tabStyles from '../tabs.module.css';
import styles from './catalog.module.css';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Hoops' own "Decoration Import" — Step 1 download template, Step 2 select
// vendor (skippable — "if you don't buy these decorations from a 3rd
// party... you can skip this step"), Step 3 upload CSV. The video ends
// before a file is actually dropped, so the preview-before-import and
// row-level error feedback below are built from the spec's written
// requirement, not copied from a reference frame — see the Phase 1
// checklist's own note on this gap.
export function ImportDecorationDialog({ vendorOptions, onClose }: { vendorOptions: VendorOption[]; onClose: () => void }) {
  const [vendorId, setVendorId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const downloadTemplate = useMutation({
    mutationFn: () => decorationsService.downloadTemplate(),
    onSuccess: (blob) => saveBlob(blob, 'decoration-import-template.csv'),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const preview = useMutation<ImportPreviewResult, unknown, File>({
    mutationFn: (chosen) => decorationsService.previewImport(chosen),
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
    mutationFn: () => decorationsService.commitImport(file!, vendorId || undefined),
    onSuccess: (res) => {
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'decorations'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const validCount = preview.data?.decorations.length ?? 0;
  const errorCount = preview.data?.errors.length ?? 0;

  return (
    <Modal open onClose={onClose} title="Decoration Import" description="Quickly & easily import your decoration price lists." maxWidth={620}>
      {result ? (
        <div className={styles.wizard}>
          <div className={styles.wizardStep}>
            <h3>
              <FiCheckCircle /> Import complete
            </h3>
            <div className={styles.summary}>
              <span>{result.created} created</span>
              <span>{result.updated} updated</span>
              {result.errors.length > 0 && <span className={styles.previewError}>{result.errors.length} skipped</span>}
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className={styles.previewTable}>
              {result.errors.map((e, i) => (
                <div key={i} className={styles.previewRow}>
                  <span>Row {e.row}</span>
                  <span className={styles.previewError}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
          <div className={styles.wizardActions}>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.wizard}>
          <div className={styles.wizardStep}>
            <h3>Step 1</h3>
            <p>
              Download the template file and add your decoration information. If you have multiple vendors who supply decoration, each
              vendor will need to be imported separately.
            </p>
            <Button type="button" variant="outline" loading={downloadTemplate.isPending} onClick={() => downloadTemplate.mutate()}>
              Download template
            </Button>
          </div>

          <div className={styles.wizardStep}>
            <h3>Step 2</h3>
            <p>Select the vendor. If you don't buy these decorations from a 3rd party (such as in-house decorators), you can skip this step.</p>
            <label className={tabStyles.selectField}>
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Skip — no vendor</option>
                {vendorOptions.map((v) => (
                  <option key={v._id} value={v._id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.wizardStep}>
            <h3>Step 3</h3>
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
            <p className={styles.hint}>
              Recommended file types: .csv. Maximum file size: 10MB. If we find any decoration names within your CSV that already exist,
              we'll update them to match your CSV.
            </p>

            {preview.isPending && <Spinner />}
            {preview.data && (
              <>
                <div className={styles.summary}>
                  <span>{validCount} ready to import</span>
                  {errorCount > 0 && <span className={styles.previewError}>{errorCount} row(s) with errors</span>}
                </div>
                <div className={styles.previewTable}>
                  {preview.data.decorations.map((d) => (
                    <div key={d.name} className={styles.previewRow}>
                      <span>{d.name}</span>
                      <span>{d.priceBreaks.length} price break(s)</span>
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

          <div className={styles.wizardActions}>
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
