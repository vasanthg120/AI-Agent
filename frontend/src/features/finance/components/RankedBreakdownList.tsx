import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiBarChart2, FiChevronRight } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import styles from '../finance.module.css';

export interface RankedItem {
  key: string;
  label: string;
  value: number;
  valueFormatted?: string;
}

// Clone of deal-performance/components/RankedBreakdownList.tsx — reused for
// Vendor-wise Spending, Category-wise Spending, Payment Method Breakdown,
// Tax Breakdown, and the subscription-provider breakdown. Each row carries
// a bar scaled to the largest value, so the ranking reads at a glance;
// when onSelect is given, the whole row is a button that drills in.
export function RankedBreakdownList({
  items,
  emptyMessage,
  coverageNote,
  onSelect,
}: {
  items: RankedItem[];
  emptyMessage: string;
  coverageNote?: string;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));

  return (
    <>
      {coverageNote && <span className={styles.coverageNote}>{coverageNote}</span>}
      {items.length === 0 ? (
        <EmptyState compact icon={FiBarChart2} title={emptyMessage} />
      ) : (
        <div className={styles.rankList}>
          {items.map((item, i) => {
            const content = (
              <>
                <span className={clsx(styles.rankPosition, i < 3 && styles.rankTop)}>{i + 1}</span>
                <span className={styles.rankBody}>
                  <span className={styles.rankLine}>
                    <span className={styles.rankName}>{item.label}</span>
                    <span className={styles.rankValue}>{item.valueFormatted ?? item.value.toLocaleString()}</span>
                  </span>
                  <span className={styles.rankTrack}>
                    <motion.span
                      className={styles.rankFill}
                      initial={{ width: 0 }}
                      animate={{ width: `${(item.value / max) * 100}%` }}
                      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 10) * 0.04 }}
                    />
                  </span>
                </span>
                {onSelect && <FiChevronRight className={styles.rankChevron} aria-hidden />}
              </>
            );
            return onSelect ? (
              <button
                key={item.key}
                type="button"
                className={clsx(styles.rankRow, styles.rankRowButton)}
                onClick={() => onSelect(item.key)}
                title={`Show documents for ${item.label}`}
              >
                {content}
              </button>
            ) : (
              <div key={item.key} className={styles.rankRow}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
