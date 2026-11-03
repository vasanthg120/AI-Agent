import type { ReactNode } from 'react';
import { FiAlignJustify, FiDownload, FiSearch } from 'react-icons/fi';
import clsx from 'clsx';
import { Button, Input, MultiSelectDropdown } from '@/components/ui';
import type { RowHeight } from './DataTable';
import styles from './TableToolbar.module.css';

export interface ToolbarColumn {
  key: string;
  label: string;
}

export interface TableToolbarProps {
  // Omit both when this view has no real server-side search to back it —
  // a search box that only filters the current page would behave
  // inconsistently with every other board's search.
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  // Extra filter controls (selects, date ranges, ...) — rendered inline,
  // same slot pattern as PageHeader's `actions`.
  filters?: ReactNode;
  columns?: ToolbarColumn[];
  visibleColumns?: string[];
  onVisibleColumnsChange?: (keys: string[]) => void;
  rowHeight?: RowHeight;
  onRowHeightChange?: (height: RowHeight) => void;
  onExport?: () => void;
  exportLabel?: string;
  // Right-aligned primary actions — "Add New", "Add View", etc.
  actions?: ReactNode;
}

const ROW_HEIGHTS: { id: RowHeight; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'spacious', label: 'Spacious' },
];

// One toolbar shape for every board (SalesBoard, Catalog, ...): search,
// caller-supplied filters, show/hide columns, row height, CSV export, and a
// right-aligned actions slot. Each piece is optional — a board that has no
// columns to hide just omits `columns`.
export function TableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search',
  filters,
  columns,
  visibleColumns,
  onVisibleColumnsChange,
  rowHeight,
  onRowHeightChange,
  onExport,
  exportLabel = 'Export',
  actions,
}: TableToolbarProps) {
  return (
    <div className={styles.toolbar}>
      {onSearchChange && (
        <div className={styles.search}>
          <Input
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            leftIcon={<FiSearch />}
          />
        </div>
      )}

      {filters}

      <div className={styles.spacer} />

      {columns && onVisibleColumnsChange && (
        <MultiSelectDropdown
          label="Columns"
          options={columns.map((c) => ({ value: c.key, label: c.label }))}
          selected={visibleColumns ?? columns.map((c) => c.key)}
          onChange={onVisibleColumnsChange}
        />
      )}

      {rowHeight && onRowHeightChange && (
        <div className={styles.rowHeightGroup} role="group" aria-label="Row height">
          {ROW_HEIGHTS.map((h) => (
            <button
              key={h.id}
              type="button"
              title={h.label}
              aria-label={h.label}
              aria-pressed={rowHeight === h.id}
              className={clsx(styles.rowHeightButton, rowHeight === h.id && styles.rowHeightActive)}
              onClick={() => onRowHeightChange(h.id)}
            >
              <FiAlignJustify aria-hidden />
            </button>
          ))}
        </div>
      )}

      {onExport && (
        <Button type="button" variant="secondary" size="sm" leftIcon={<FiDownload />} onClick={onExport}>
          {exportLabel}
        </Button>
      )}

      {actions}
    </div>
  );
}
