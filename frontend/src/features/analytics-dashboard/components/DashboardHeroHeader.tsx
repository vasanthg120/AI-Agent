import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import { FiFilter, FiCalendar, FiBox, FiDownload, FiChevronDown, FiX } from 'react-icons/fi';
import { MONTH_NAMES, CURRENT_YEAR, CURRENT_MONTH, YEAR_OPTIONS, rangeForMonth } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { dealsService } from '@/services/dealsService';
import { extractErrorMessage } from '@/utils/errors';
import { useClickOutside } from '@/hooks/useClickOutside';
import styles from './DashboardHeroHeader.module.css';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// True exactly when {dateFrom, dateTo} is what rangeForMonth(year, month)
// itself would produce (start of month → today, or the full month if it's
// already past) — i.e. the range is still expressible as a single Month/Year
// selection, not a custom span. Drives which mode the picker opens in and
// how the "Applied filters" pill labels the period, so an arbitrary Advanced
// range never gets mislabeled as if it were a whole calendar month.
function isFullMonthRange(dateFrom: string, dateTo: string): boolean {
  const start = dayjs(dateFrom);
  if (!start.isValid() || !start.isSame(start.startOf('month'), 'day')) return false;
  const expected = rangeForMonth(start.year(), start.month() + 1);
  return expected.dateTo === dateTo;
}

export interface DashboardHeroHeaderProps {
  firstName?: string;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
  dateFrom: string;
  dateTo: string;
  storeId?: string;
  onStoreChange: (id: string | undefined) => void;
  stores: { id: string; name: string }[];
  canOverrideStore: boolean;
}

export function DashboardHeroHeader({
  firstName,
  range,
  onRangeChange,
  dateFrom,
  dateTo,
  storeId,
  onStoreChange,
  stores,
  canOverrideStore,
}: DashboardHeroHeaderProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const [storePickerOpen, setStorePickerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Purely a UI display toggle (which picker the popover shows), not itself
  // part of the applied range — defaults to whichever mode actually explains
  // the current dateFrom/dateTo, so opening the popover on an
  // already-custom range doesn't misleadingly show a Month/Year picker with
  // nothing selected.
  const [advancedMode, setAdvancedMode] = useState(() => !isFullMonthRange(dateFrom, dateTo));
  const periodRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef<HTMLDivElement>(null);

  useClickOutside(periodRef, () => setPeriodPickerOpen(false), periodPickerOpen);
  useClickOutside(storeRef, () => setStorePickerOpen(false), storePickerOpen);

  // Both dimensions are always "applied" to the workspace view (store
  // defaults to All stores, period defaults to the current month) — the
  // badge and the panel below count/show both unconditionally rather than
  // only non-default overrides, matching how the reference design always
  // shows both as removable chips.
  const activeFilterCount = (canOverrideStore ? 1 : 0) + 1;
  const storeName = storeId ? stores.find((s) => s.id === storeId)?.name ?? 'Selected store' : 'All stores';
  const periodLabel = `${dayjs(dateFrom).format('MMM DD')} – ${dayjs(dateTo).format('MMM DD, YYYY')}`;

  // Read straight from `range` every render rather than mirroring it into
  // local state — same reasoning as MonthYearFilterPopup's own comment on
  // this (a local copy is what caused its old default-highlight-mismatch bug).
  const current = range.dateFrom ? dayjs(range.dateFrom) : dayjs();
  const selectedYear = current.year();
  const selectedMonth = current.month() + 1;
  const maxMonthForYear = selectedYear === CURRENT_YEAR ? CURRENT_MONTH : 12;
  const isCurrentMonth = selectedYear === CURRENT_YEAR && selectedMonth === CURRENT_MONTH;
  // "August 2026" only when the applied range really is that whole month —
  // an Advanced custom span shows its literal dates instead, same format the
  // toolbar's own periodLabel already uses, so the pill never claims a range
  // is a calendar month when it isn't.
  const monthLabel = isFullMonthRange(dateFrom, dateTo) ? current.format('MMMM YYYY') : periodLabel;

  const handleExport = async () => {
    setExporting(true);
    try {
      await dealsService.downloadExport('csv', {
        dateFrom,
        dateTo,
        dateField: 'expectedClosingDate',
        ...(storeId ? { storeId: [storeId] } : {}),
      });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const resetPeriod = () => {
    setAdvancedMode(false);
    onRangeChange(rangeForMonth(CURRENT_YEAR, CURRENT_MONTH));
  };

  return (
    <div className={styles.hero}>
      <div className={styles.liveBadge}>
        <span className={styles.liveDot} />
        Live Workspace View
      </div>

      <div className={styles.topRow}>
        <div>
          <h1 className={styles.title}>
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className={styles.subtitle}>Here's what's happening across your business today.</p>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.filtersButton} onClick={() => setFiltersOpen((p) => !p)}>
            <FiFilter size={14} />
            Filters
            {activeFilterCount > 0 && <span className={styles.filterBadge}>{activeFilterCount}</span>}
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarPickerWrap} ref={periodRef}>
          <button type="button" className={styles.toolbarItem} onClick={() => setPeriodPickerOpen((p) => !p)}>
            <FiCalendar size={14} />
            <span className={styles.toolbarLabel}>Reporting period</span>
            <span className={styles.toolbarValue}>{periodLabel}</span>
            <FiChevronDown size={13} className={styles.toolbarChevron} />
          </button>

          {periodPickerOpen && (
            <div className={styles.pickerPanel}>
              <div className={styles.pickerHeaderRow}>
                <span className={styles.filterLabel}>Reporting period</span>
                <button type="button" className={styles.modeToggle} onClick={() => setAdvancedMode((p) => !p)}>
                  {advancedMode ? 'Use month picker' : 'Advanced'}
                </button>
              </div>

              {advancedMode ? (
                <>
                  <div className={styles.advancedRow}>
                    <div className={styles.advancedField}>
                      <label htmlFor="reporting-start-date">Start date</label>
                      <input
                        id="reporting-start-date"
                        type="date"
                        className={styles.filterSelect}
                        value={dateFrom}
                        max={dateTo}
                        onChange={(e) => e.target.value && onRangeChange({ dateFrom: e.target.value, dateTo })}
                      />
                    </div>
                    <div className={styles.advancedField}>
                      <label htmlFor="reporting-end-date">End date</label>
                      <input
                        id="reporting-end-date"
                        type="date"
                        className={styles.filterSelect}
                        value={dateTo}
                        min={dateFrom}
                        max={dayjs().format('YYYY-MM-DD')}
                        onChange={(e) => e.target.value && onRangeChange({ dateFrom, dateTo: e.target.value })}
                      />
                    </div>
                  </div>
                  {!isFullMonthRange(dateFrom, dateTo) && (
                    <span className={styles.advancedNote}>
                      Revenue-against-target figures reflect the target for the start date's month.
                    </span>
                  )}
                </>
              ) : (
                <div className={styles.monthYearRow}>
                  <select
                    aria-label="Month"
                    className={styles.filterSelect}
                    value={selectedMonth}
                    onChange={(e) => onRangeChange(rangeForMonth(selectedYear, Number(e.target.value)))}
                  >
                    {MONTH_NAMES.slice(0, maxMonthForYear).map((name, i) => (
                      <option key={name} value={i + 1}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Year"
                    className={styles.filterSelect}
                    value={selectedYear}
                    onChange={(e) => {
                      const nextYear = Number(e.target.value);
                      const nextMax = nextYear === CURRENT_YEAR ? CURRENT_MONTH : 12;
                      onRangeChange(rangeForMonth(nextYear, Math.min(selectedMonth, nextMax)));
                    }}
                  >
                    {YEAR_OPTIONS.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(advancedMode || !isCurrentMonth) && (
                <button type="button" className={styles.resetBtn} onClick={resetPeriod}>
                  Back to current month
                </button>
              )}
            </div>
          )}
        </div>

        {canOverrideStore && (
          <>
            <span className={styles.toolbarDivider} />
            <div className={styles.toolbarPickerWrap} ref={storeRef}>
              <button type="button" className={styles.toolbarItem} onClick={() => setStorePickerOpen((p) => !p)}>
                <FiBox size={14} />
                <span className={styles.toolbarLabel}>View</span>
                <span className={styles.toolbarValue}>{storeName}</span>
                <FiChevronDown size={13} className={styles.toolbarChevron} />
              </button>

              {storePickerOpen && (
                <div className={styles.pickerPanel}>
                  <span className={styles.filterLabel}>Store</span>
                  <select className={styles.filterSelect} value={storeId ?? ''} onChange={(e) => onStoreChange(e.target.value || undefined)}>
                    <option value="">All stores</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </>
        )}

        <button type="button" className={styles.exportLink} onClick={() => void handleExport()} disabled={exporting}>
          <FiDownload size={14} />
          {exporting ? 'Exporting…' : 'Export report'}
        </button>
      </div>

      {filtersOpen && (
        <div className={styles.appliedFiltersBar}>
          <div className={styles.appliedFiltersText}>
            <span className={styles.appliedFiltersTitle}>Applied filters</span>
            <span className={styles.appliedFiltersSubtitle}>Refine the workspace without leaving the page.</span>
          </div>

          <div className={styles.appliedFiltersPills}>
            {canOverrideStore && (
              <span className={styles.pill}>
                {storeName}
                <button type="button" aria-label="Reset store filter" onClick={() => onStoreChange(undefined)}>
                  <FiX size={12} />
                </button>
              </span>
            )}
            <span className={styles.pill}>
              {monthLabel}
              <button type="button" aria-label="Reset reporting period" onClick={resetPeriod}>
                <FiX size={12} />
              </button>
            </span>
          </div>

          <button type="button" className={styles.doneBtn} onClick={() => setFiltersOpen(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
