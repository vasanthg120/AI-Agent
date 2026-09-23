import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCheckCircle, FiFileText, FiRefreshCw, FiUpload } from 'react-icons/fi';
import { Badge, Button, Spinner } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { businessKnowledgeDocumentsService, type BusinessKnowledgeDocument } from '@/services/businessKnowledgeDocumentsService';
import styles from '../business-knowledge.module.css';

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp,.html,.htm,.txt,.md';

// Terms & Conditions is document-upload-based, not free text — it reuses the
// EXISTING Business Knowledge document pipeline end to end (GridFS ->
// extraction -> chunk -> embed -> Qdrant, via businessKnowledgeDocumentsService,
// completely unchanged) rather than a second processing system. It's treated
// as a singleton per org by convention: the most recently created document
// tagged assetType: 'terms_and_conditions' (see the schema comment for why
// that value was added) is "the" current one. "Replace Document" removes the
// old one first (existing remove(), which already purges GridFS + Qdrant +
// Mongo) before uploading the new one, so the Agent is never left with two
// T&C documents or a stale one lingering — same cleanup guarantee every
// other Business Knowledge document already has.
export function TermsAndConditionsPolicy({ canEdit }: { canEdit: boolean }) {
  const [doc, setDoc] = useState<BusinessKnowledgeDocument | null | undefined>(undefined); // undefined = still loading
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const result = await businessKnowledgeDocumentsService.listFiltered({ assetType: ['terms_and_conditions'] }, 1, 1);
    setDoc(result.items[0] ?? null);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleFileSelected = async (file: File) => {
    setBusy(true);
    try {
      if (doc) {
        await businessKnowledgeDocumentsService.remove(doc._id);
      }
      const uploaded = await businessKnowledgeDocumentsService.upload(file);
      // Extraction AI-classifies assetType like any other document (it has
      // no concept of "the org's singleton T&C") — force it to the tag this
      // section looks up by, via the same update() endpoint the Documents
      // tab's own review modal already uses for human corrections.
      const tagged = await businessKnowledgeDocumentsService.update(uploaded._id, { assetType: 'terms_and_conditions' });
      setDoc(tagged);
      toast.success(tagged.extractionStatus === 'completed' ? 'Terms & Conditions analysed' : `${file.name} uploaded — extraction failed`);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRetry = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const retried = await businessKnowledgeDocumentsService.retryExtraction(doc._id);
      // A retry re-runs AI classification too — reassert the singleton tag
      // every time, same reasoning as the fresh-upload path above.
      const tagged = await businessKnowledgeDocumentsService.update(retried._id, { assetType: 'terms_and_conditions' });
      setDoc(tagged);
      toast.success(tagged.extractionStatus === 'completed' ? 'Terms & Conditions analysed' : 'Extraction failed again');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (doc === undefined) {
    return <Spinner size={16} />;
  }

  return (
    <div className={styles.formGrid}>
      <span className={styles.fieldLabel}>Terms & Conditions</span>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileSelected(file);
        }}
      />

      {!doc ? (
        canEdit ? (
          <div
            className={styles.tcDropzone}
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !busy) fileInputRef.current?.click();
            }}
          >
            <span className={styles.tcDropzoneIcon}>{busy ? <Spinner size={18} /> : <FiUpload size={18} />}</span>
            <span className={styles.tcDropzoneText}>{busy ? 'Uploading…' : 'Click to upload your Terms & Conditions document'}</span>
            <span className={styles.tcDropzoneHint}>PDF, DOCX, PPTX, XLSX, CSV, HTML, TXT, MD, or image</span>
          </div>
        ) : (
          <div className={styles.emptyState}>No Terms & Conditions document has been uploaded yet.</div>
        )
      ) : (
        <div className={styles.tcDocCard}>
          <div className={styles.tcDocInfo}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {doc.extractionStatus === 'completed' && (
                <Badge variant="success">
                  <FiCheckCircle style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  Terms & Conditions analysed
                </Badge>
              )}
              {doc.extractionStatus === 'processing' && <Badge variant="info">Analysing…</Badge>}
              {doc.extractionStatus === 'failed' && <Badge variant="danger">Extraction failed</Badge>}
            </div>
            <span className={styles.tcDocFilename}>
              <FiFileText style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {doc.originalFilename}
            </span>
            {doc.extractionStatus === 'failed' && doc.extractionError && <span className={styles.tcDocFilename}>{doc.extractionError}</span>}
          </div>
          {canEdit && (
            <div className={styles.tcDocActions}>
              {doc.extractionStatus === 'failed' && (
                <Button type="button" variant="outline" size="sm" leftIcon={<FiRefreshCw />} loading={busy} disabled={busy} onClick={() => void handleRetry()}>
                  Retry
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" leftIcon={<FiUpload />} loading={busy} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                Replace Document
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
