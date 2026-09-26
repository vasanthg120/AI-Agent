import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiChevronRight, FiList, FiSearch } from 'react-icons/fi';
import { EmptyState, Modal, Skeleton } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import styles from './DrillDownModal.module.css';

export interface DrillDownRow {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  value?: number;
}

type SortMode = 'value' | 'name';

// Generic, dumb list renderer — every data-shape-specific mapping (deals/
// quotes/emails -> DrillDownRow) happens in the page, so this component
// never needs to know which of the three data types it's showing. On top of
// the plain list it adds what a long list needs to be usable: a count and
// total up top, search (once there are enough rows to need it), a value/
// name sort, and a bar on each row showing its share of the largest value.
export function DrillDownModal({
  open,
  onClose,
  title,
  isLoading,
  rows,
  formatValue,
  onRowClick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  isLoading: boolean;
  rows: DrillDownRow[];
  // Additive, backward-compatible — Business Intelligence needs percentage/
  // count formatting for several sections, not just this component's
  // original hardcoded INR currency. Omitted (the default) keeps every
  // existing call site's money() formatting unchanged.
  formatValue?: (n: number) => string;
  // Additive — the Customers & Email tab's popups drill a second level deep
  // (a business row opens its correlated emails, a missed-email row opens
  // the full email). Omitted (the default) keeps every existing call site's
  // static, non-clickable rows unchanged.
  onRowClick?: (row: DrillDownRow) => void;
}) {
  const renderValue = formatValue ?? money;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode | null>(null);

  // Each open starts fresh — a search typed into one drill-down shouldn't
  // silently filter the next one.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSort(null);
    }
  }, [open, title]);

  const hasValues = rows.some((r) => r.value !== undefined);
  // Summing is only meaningful for money — a custom formatter means counts/percentages.
  const total = hasValues && !formatValue ? rows.reduce((s, r) => s + (r.value ?? 0), 0) : null;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value ?? 0)));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => [r.title, r.subtitle, r.meta].some((f) => f?.toLowerCase().includes(q)))
      : rows;
    // null = keep the caller's own order (often already meaningful, e.g. by date).
    if (sort === 'value') return [...filtered].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (sort === 'name') return [...filtered].sort((a, b) => a.title.localeCompare(b.title));
    return filtered;
  }, [rows, query, sort]);

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth={680}>
      {!isLoading && rows.length > 0 && (
        <div className={styles.summary}>
          <span className={styles.summaryStat}>
            <strong>{rows.length}</strong> record{rows.length === 1 ? '' : 's'}
          </span>
          {total !== null && (
            <span className={styles.summaryStat}>
              <strong>{money(total)}</strong> total
            </span>
          )}
          {hasValues && (
            <div className={styles.sort} role="radiogroup" aria-label="Sort">
              {(['value', 'name'] as SortMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={sort === m}
                  className={clsx(styles.sortButton, sort === m && styles.sortButtonActive)}
                  onClick={() => setSort(sort === m ? null : m)}
                >
                  {m === 'value' ? 'Highest first' : 'A–Z'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!isLoading && rows.length > 6 && (
        <label className={styles.search}>
          <FiSearch aria-hidden />
          <input autoFocus value={query} placeholder="Search this list" onChange={(e) => setQuery(e.target.value)} />
          {query && <span className={styles.searchCount}>{visible.length} found</span>}
        </label>
      )}

      <div className={styles.list}>
        {isLoading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height={58} />)
        ) : rows.length === 0 ? (
          <EmptyState compact icon={FiList} title="No records for this selection" description="Try a wider date range." />
        ) : visible.length === 0 ? (
          <EmptyState compact icon={FiSearch} title="Nothing matches your search" />
        ) : (
          visible.map((r, i) => {
            const content = (
              <>
                <span className={styles.index}>{i + 1}</span>
                <span className={styles.main}>
                  <span className={styles.title}>{r.title}</span>
                  {(r.subtitle || r.meta) && (
                    <span className={styles.meta}>
                      {r.subtitle && <span className={styles.chip}>{r.subtitle}</span>}
                      {r.meta && <span>{r.meta}</span>}
                    </span>
                  )}
                  {r.value !== undefined && (
                    <span className={styles.track}>
                      <motion.span
                        className={styles.fill}
                        initial={{ width: 0 }}
                        animate={{ width: `${(Math.abs(r.value) / max) * 100}%` }}
                        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 12) * 0.025 }}
                      />
                    </span>
                  )}
                </span>
                {r.value !== undefined && <strong className={styles.value}>{renderValue(r.value)}</strong>}
                {onRowClick && <FiChevronRight className={styles.chevron} aria-hidden />}
              </>
            );
            const motionProps = {
              initial: { opacity: 0 },
              animate: { opacity: 1 },
              transition: { duration: 0.22, delay: Math.min(i, 12) * 0.025 },
            };
            return onRowClick ? (
              <motion.button
                key={r.id}
                type="button"
                className={clsx(styles.row, styles.rowClickable)}
                onClick={() => onRowClick(r)}
                {...motionProps}
              >
                {content}
              </motion.button>
            ) : (
              <motion.div key={r.id} className={styles.row} {...motionProps}>
                {content}
              </motion.div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
