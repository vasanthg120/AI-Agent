import { Badge, Button, Modal } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import type { CallFollowUpAction } from '@/services/callCopilotService';
import styles from './CallSummaryModal.module.css';

const PRIORITY_VARIANT: Record<CallFollowUpAction['priority'], BadgeVariant> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

export interface CallSummaryModalProps {
  open: boolean;
  onClose: () => void;
  summary: string;
  keyTakeaways: string[];
  followUpActions: CallFollowUpAction[];
}

// Display-only, by design — follow-up actions are shown for the salesperson
// to action themselves; nothing here writes to the CRM automatically (per
// the confirmed requirement).
export function CallSummaryModal({ open, onClose, summary, keyTakeaways, followUpActions }: CallSummaryModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Call Summary" maxWidth={560}>
      <div className={styles.body}>
        <p className={styles.summary}>{summary || 'No summary was generated for this call.'}</p>

        {keyTakeaways.length > 0 && (
          <div>
            <h4 className={styles.sectionTitle}>Key Takeaways</h4>
            <ul className={styles.list}>
              {keyTakeaways.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          </div>
        )}

        {followUpActions.length > 0 && (
          <div>
            <h4 className={styles.sectionTitle}>Suggested Follow-Ups</h4>
            <p className={styles.hint}>These are not created in your CRM automatically — add the ones you want yourself.</p>
            <div className={styles.followUpList}>
              {followUpActions.map((action, i) => (
                <div key={i} className={styles.followUpRow}>
                  <Badge variant={PRIORITY_VARIANT[action.priority]}>{action.priority}</Badge>
                  <span>{action.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.footer}>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
