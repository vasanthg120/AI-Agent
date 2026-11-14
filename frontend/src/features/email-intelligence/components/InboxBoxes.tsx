import clsx from 'clsx';
import { INBOX_BOXES, type InboxBox } from '@/services/emailIntelligenceService';
import { ACTION_BOXES, BOX_META } from '../inboxBoxes';
import styles from './InboxBoxes.module.css';

// The inbox's boxes as one row of tabs, each with its count: what needs you
// first (new enquiries, replies owed), then what is answered, and junk set
// aside at the end. Every email is in exactly one box.
export function InboxBoxes({
  counts,
  active,
  onChange,
}: {
  counts?: Record<InboxBox, number>;
  active: InboxBox;
  onChange: (box: InboxBox) => void;
}) {
  return (
    <div className={styles.boxes} role="tablist" aria-label="Inbox boxes">
      {INBOX_BOXES.map((box) => {
        const meta = BOX_META[box];
        const Icon = meta.icon;
        const count = counts?.[box];
        const waiting = ACTION_BOXES.includes(box) && (count ?? 0) > 0;
        return (
          <button
            key={box}
            type="button"
            role="tab"
            aria-selected={box === active}
            className={clsx(styles.box, styles[`tone_${meta.tone}`], box === active && styles.active, waiting && styles.waiting)}
            onClick={() => onChange(box)}
          >
            <span className={styles.top}>
              <span className={styles.icon} aria-hidden>
                <Icon />
              </span>
              <span className={styles.count}>{count === undefined ? '–' : count.toLocaleString()}</span>
            </span>
            <span className={styles.label}>{meta.label}</span>
            <span className={styles.hint}>{meta.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
