import { FiInbox } from 'react-icons/fi';
import { Card, EmptyState } from '@/components/ui';
import { pressable } from '@/utils/pressable';
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
      <div className={styles.title}>By intent</div>

      {byIntent.length === 0 ? (
        <EmptyState compact icon={FiInbox} title="No relevant emails in this period" />
      ) : (
        <div className={styles.list}>
          {byIntent.map((row) => (
            <div
              key={row.intent}
              className={styles.row}
              {...(onIntentClick ? pressable(() => onIntentClick(row.intent, row.label)) : {})}
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
