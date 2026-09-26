import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiArrowDown, FiArrowUp, FiDownload, FiSearch } from 'react-icons/fi';
import { Button, EmptyState } from '@/components/ui';
import styles from '../reporting.module.css';

const EASE = [0.16, 1, 0.3, 1] as const;

// ---------- KPI tiles ----------

export interface Kpi {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: IconType;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}

export function KpiRow({ items }: { items: Kpi[] }) {
  return (
    <div className={styles.kpiRow}>
      {items.map(({ label, value, hint, icon: Icon, tone = 'accent' }, i) => (
        <motion.div
          key={label}
          className={clsx(styles.kpi, styles[`tone_${tone}`])}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: EASE, delay: i * 0.06 }}
        >
          <span className={styles.kpiIcon}>
            <Icon />
          </span>
          <span className={styles.kpiLabel}>{label}</span>
          <span className={styles.kpiValue}>{value}</span>
          {hint && <span className={styles.kpiHint}>{hint}</span>}
        </motion.div>
      ))}
    </div>
  );
}

// ---------- Sortable, searchable table with optional share bars ----------

export interface ReportColumn<T> {
  key: string;
  label: string;
  /** What is shown in the cell. */
  render: (row: T) => ReactNode;
  /** What the column sorts by and exports as. */
  value: (row: T) => number | string;
  /** 0–100: draws a proportional bar behind the cell (e.g. % of total). */
  bar?: (row: T) => number;
  numeric?: boolean;
}

function toCsv<T>(columns: ReportColumn<T>[], rows: T[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join(
    '\n',
  );
}

export function ReportTable<T>({
  columns,
  rows,
  rowKey,
  filename,
  searchPlaceholder = 'Search rows',
  defaultSort,
}: {
  columns: ReportColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  filename: string;
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(defaultSort ?? { key: columns[0].key, dir: 'asc' as 'asc' | 'desc' });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => String(columns[0].value(r)).toLowerCase().includes(q)) : rows;
    const col = columns.find((c) => c.key === sort.key) ?? columns[0];
    return [...filtered].sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, columns, query, sort]);

  const toggleSort = (key: string, numeric?: boolean) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: numeric ? 'desc' : 'asc' }));

  const download = () => {
    const blob = new Blob([toCsv(columns, visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.tableBlock}>
      <div className={styles.tableToolbar}>
        <label className={styles.tableSearch}>
          <FiSearch aria-hidden />
          <input value={query} placeholder={searchPlaceholder} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <span className={styles.tableCount}>
          {visible.length} of {rows.length}
        </span>
        <Button type="button" variant="outline" size="sm" leftIcon={<FiDownload />} onClick={download} disabled={visible.length === 0}>
          Download CSV
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyState compact icon={FiSearch} title="No matching rows" description="Try a different search." />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.reportTable}>
            <thead>
              <tr>
                {columns.map((c) => {
                  const active = sort.key === c.key;
                  return (
                    <th key={c.key} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button
                        type="button"
                        className={clsx(styles.sortButton, active && styles.sortButtonActive)}
                        onClick={() => toggleSort(c.key, c.numeric)}
                      >
                        {c.label}
                        <span className={styles.sortIcon}>{active && sort.dir === 'asc' ? <FiArrowUp /> : <FiArrowDown />}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <motion.tr
                  key={rowKey(row)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.02 }}
                >
                  {columns.map((c) => (
                    <td key={c.key}>
                      {c.bar ? (
                        <span className={styles.barCell}>
                          <span className={styles.barTrack}>
                            <motion.span
                              className={styles.barFill}
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.max(0, Math.min(100, c.bar(row)))}%` }}
                              transition={{ duration: 0.7, ease: EASE, delay: 0.1 + Math.min(i, 12) * 0.02 }}
                            />
                          </span>
                          <span className={styles.barValue}>{c.render(row)}</span>
                        </span>
                      ) : (
                        c.render(row)
                      )}
                    </td>
                  ))}
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
