import type { ReactNode } from 'react';
import { FiArrowDown } from 'react-icons/fi';
import clsx from 'clsx';
import { Skeleton } from '@/components/ui';
import styles from './DataTable.module.css';

export type RowHeight = 'compact' | 'comfortable' | 'spacious';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  width?: number;
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  // Always shown regardless of the column-visibility selection (e.g. the
  // primary identifying column) — TableToolbar's column menu never offers
  // to hide it.
  alwaysVisible?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataTableSort {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  // Omit to show every column — same convention as TableToolbar's
  // visibleColumns (undefined = "not managed here").
  visibleColumns?: string[];
  rowHeight?: RowHeight;
  loading?: boolean;
  skeletonRows?: number;
  busy?: boolean;
  sort?: DataTableSort;
  onSortChange?: (key: string) => void;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
}

// The one configurable board table every Hoops-parity board (SalesBoard,
// Catalog, ...) renders through — column visibility and row height are
// state the caller owns (so a view can be remembered per page), this
// component only renders what it's given. Existing hand-rolled tables
// (CustomersPage, JobBoard) predate this and are deliberately left as-is —
// they already work and rewriting them wasn't asked for.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  visibleColumns,
  rowHeight = 'comfortable',
  loading,
  skeletonRows = 6,
  busy,
  sort,
  onSortChange,
  onRowClick,
  emptyState,
}: DataTableProps<T>) {
  const shown = columns.filter((c) => c.alwaysVisible || !visibleColumns || visibleColumns.includes(c.key));

  if (loading) {
    return (
      <div className={styles.wrap}>
        <div className={styles.tableWrap}>
          <table className={clsx(styles.table, styles[`height_${rowHeight}`])}>
            <thead>
              <tr>
                {shown.map((c) => (
                  <th key={c.key} style={{ width: c.width, minWidth: c.minWidth }}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
          </table>
          <div className={styles.skeletonBody}>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <Skeleton key={i} height={rowHeight === 'compact' ? 28 : rowHeight === 'spacious' ? 48 : 36} />
            ))}
          </div>
        </div>
        <div className={styles.cardList}>
          {Array.from({ length: Math.min(skeletonRows, 4) }).map((_, i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  // The primary column (alwaysVisible, or the first shown one) becomes the
  // card's heading below the container-query breakpoint; every other shown
  // column becomes a label:value fact — same split JobBoard.tsx's own
  // hand-rolled `.cards` fallback uses, generalized so it comes free with
  // every DataTable instead of each page re-building it.
  const primary = shown.find((c) => c.alwaysVisible) ?? shown[0];
  const facts = shown.filter((c) => c !== primary);

  return (
    <div className={styles.wrap}>
      <div className={styles.tableWrap} aria-busy={busy}>
        <table className={clsx(styles.table, styles[`height_${rowHeight}`])}>
          <thead>
            <tr>
              {shown.map((c) => {
                const sorted = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ width: c.width, minWidth: c.minWidth }}
                    className={clsx(c.align === 'right' && styles.alignRight, c.align === 'center' && styles.alignCenter)}
                    aria-sort={sorted ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        className={clsx(styles.sortButton, sorted && styles.sortActive, sorted && sort?.direction === 'asc' && styles.sortAsc)}
                        onClick={() => onSortChange?.(c.key)}
                      >
                        {c.header}
                        <FiArrowDown aria-hidden />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={clsx(styles.row, onRowClick && styles.rowClickable)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={() => onRowClick?.(row)}
                onKeyDown={(e) => {
                  if (!onRowClick) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }}
              >
                {shown.map((c) => (
                  <td
                    key={c.key}
                    className={clsx(c.align === 'right' && styles.alignRight, c.align === 'center' && styles.alignCenter)}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.cardList} aria-busy={busy} role="list">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            role="listitem"
            className={clsx(styles.card, onRowClick && styles.rowClickable)}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={() => onRowClick?.(row)}
            onKeyDown={(e) => {
              if (!onRowClick) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRowClick(row);
              }
            }}
          >
            <div className={styles.cardHead}>{primary.render(row)}</div>
            {facts.length > 0 && (
              <dl className={styles.cardFacts}>
                {facts.map((c) => (
                  <div key={c.key}>
                    <dt>{c.header}</dt>
                    <dd>{c.render(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
