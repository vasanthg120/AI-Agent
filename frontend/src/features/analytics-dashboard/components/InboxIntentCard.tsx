import { Card } from '@/components/ui';
import styles from './InboxIntentCard.module.css';

export interface InboxIntentCardProps {
  byIntent: { intent: string; label: string; receivedCount: number }[];
  onIntentClick?: (intent: string, label: string) => void;
}

export function InboxIntentCard({ byIntent, onIntentClick }: InboxIntentCardProps) {
  const max = Math.max(1, ...byIntent.map((i) => i.receivedCount));

  return (
    <Card className={styles.card}>
      <div className={styles.label}>Inbox Intelligence</div>
      <div className={styles.title}>
        By intent
      </div>

      {byIntent.length === 0 ? (
        <div className={styles.empty}>No relevant emails in this period.</div>
      ) : (
        <div className={styles.list}>
          {byIntent.map((row) => (
            <div
              key={row.intent}
              className={styles.row}
              role={onIntentClick ? 'button' : undefined}
              tabIndex={onIntentClick ? 0 : undefined}
              onClick={onIntentClick ? () => onIntentClick(row.intent, row.label) : undefined}
            >
              <div className={styles.rowHeader}>
                <span className={styles.rowLabel}>{row.label}</span>
                <span className={styles.rowValue}>{row.receivedCount}</span>
              </div>
              <div className={styles.track}>
                <div className={styles.fill} style={{ width: `${(row.receivedCount / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
