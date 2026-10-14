import { Button, Modal } from '@/components/ui';
import { dayjs } from '@/utils/date';
import type { SyncPreviewResult } from '@/services/emailIntelligenceService';
import styles from '../email-intelligence.module.css';

interface EmailSyncPreviewModalProps {
  open: boolean;
  preview: SyncPreviewResult | null;
  syncing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function formatTokens(value: number | null): string {
  return value == null ? '—' : `~${value.toLocaleString()}`;
}

// Phase 21 follow-up — a real modal (not the old window.confirm) since
// there's now a genuine breakdown worth laying out, not just one sentence.
// Every number here is real: newCount/alreadyAnalyzedCount/autoSkippedCount/
// willAnalyzeCount all come from a dry-run of the exact same deterministic
// gates the real sync applies, and the token estimate is either a real
// historical average or an honest "—", never a guess.
export function EmailSyncPreviewModal({ open, preview, syncing, onCancel, onConfirm }: EmailSyncPreviewModalProps) {
  if (!preview) return null;
  const newCount = preview.scannedCount - preview.alreadyAnalyzedCount;
  const nothingToDo = preview.willAnalyzeCount === 0 && preview.autoSkippedCount === 0;

  return (
    <Modal open={open} onClose={onCancel} title="AI Email Sync Preview" maxWidth={420}>
      <div className={styles.previewSection}>
        <div className={styles.previewRow}>
          <span>New emails</span>
          <span>{newCount}</span>
        </div>
        <div className={styles.previewRow}>
          <span>Already analyzed</span>
          <span>{preview.alreadyAnalyzedCount}</span>
        </div>
        <div className={styles.previewRow}>
          <span>Skipped automatically</span>
          <span>{preview.autoSkippedCount}</span>
        </div>
        <div className={styles.previewRow}>
          <span>Will analyze</span>
          <span>{preview.willAnalyzeCount}</span>
        </div>
      </div>

      <div className={styles.previewDivider} />

      <div className={styles.previewSection}>
        <div className={styles.previewRow}>
          <span>Estimated AI calls</span>
          <span>{preview.willAnalyzeCount}</span>
        </div>
        <div className={styles.previewRow}>
          <span>Estimated input tokens</span>
          <span>{formatTokens(preview.estimatedInputTokens)}</span>
        </div>
        <div className={styles.previewRow}>
          <span>Estimated output tokens</span>
          <span>{formatTokens(preview.estimatedOutputTokens)}</span>
        </div>
      </div>

      {preview.estimatedBasis === 'no_history' && preview.willAnalyzeCount > 0 && (
        <div className={styles.previewHint}>
          No AI call history yet — a token estimate will appear after your first sync.
        </div>
      )}

      <div className={styles.previewLastSync}>
        Last AI Sync: {preview.lastSyncedAt ? dayjs(preview.lastSyncedAt).format('MMM D, YYYY h:mm A') : 'Never'}
      </div>

      <div className={styles.previewActions}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={syncing}>
          Cancel
        </Button>
        <Button type="button" onClick={onConfirm} loading={syncing} disabled={nothingToDo}>
          Sync with AI
        </Button>
      </div>
    </Modal>
  );
}
