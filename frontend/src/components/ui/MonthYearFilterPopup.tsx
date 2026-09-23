import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import { AnimatePresence, motion } from 'framer-motion';
import { FiCalendar, FiChevronDown } from 'react-icons/fi';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { DateRange } from './DateRangeControl';
import { POPUP_SPRING } from './motionPresets';
import styles from './MonthYearFilterPopup.module.css';

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');

// Replaces the old 11-preset tab strip (Today/Yesterday/Week/Last Week/
// Month/Last Month/Quarter/Last Quarter/Year/Last Year/Custom) with a single
// month + year picker — every dashboard metric (deals, quotes, won/lost) is
// filtered this same way, so one control is enough. Same "start of period
// through today, never into the future" rule as the old "This Month" preset
// (see DateRangeControl.tsx's presetToRange) — a past month gets its full
// range, the current month is capped at today. Exported — DashboardHeroHeader
// reuses this to render its own inline month/year selects (nesting this
// component's own trigger+popover inside another popover looked visually
// disconnected, floating outside the outer panel's bounds).
export function rangeForMonth(year: number, month: number): DateRange {
  const today = dayjs();
  const start = dayjs(new Date(year, month - 1, 1));
  const naturalEnd = start.endOf('month');
  const end = naturalEnd.isAfter(today) ? today : naturalEnd;
  return { dateFrom: fmt(start), dateTo: fmt(end) };
}

export const CURRENT_YEAR = dayjs().year();
export const CURRENT_MONTH = dayjs().month() + 1;
export const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

export function MonthYearFilterPopup({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Read straight from `value` every render rather than mirroring it into
  // local state — DateRangeControl's `activeId` local copy is what caused
  // its default-highlight-mismatch bug (see AnalyticsDashboardPage's default
  // resolving to "This Month" but the tab showing "Custom").
  const current = value.dateFrom ? dayjs(value.dateFrom) : dayjs();
  const year = current.year();
  const month = current.month() + 1;
  const maxMonthForYear = year === CURRENT_YEAR ? CURRENT_MONTH : 12;

  useClickOutside(wrapperRef, () => setOpen(false), open);

  const isCurrentMonth = year === CURRENT_YEAR && month === CURRENT_MONTH;

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((p) => !p)}>
        <FiCalendar size={14} />
        <span>{current.format('MMMM YYYY')}</span>
        <FiChevronDown size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.panel}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            <div className={styles.row}>
              <select
                aria-label="Month"
                className={styles.select}
                value={month}
                onChange={(e) => onChange(rangeForMonth(year, Number(e.target.value)))}
              >
                {MONTH_NAMES.slice(0, maxMonthForYear).map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Year"
                className={styles.select}
                value={year}
                onChange={(e) => {
                  const nextYear = Number(e.target.value);
                  const nextMax = nextYear === CURRENT_YEAR ? CURRENT_MONTH : 12;
                  onChange(rangeForMonth(nextYear, Math.min(month, nextMax)));
                }}
              >
                {YEAR_OPTIONS.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            {!isCurrentMonth && (
              <button
                type="button"
                className={styles.resetBtn}
                onClick={() => {
                  onChange(rangeForMonth(CURRENT_YEAR, CURRENT_MONTH));
                  setOpen(false);
                }}
              >
                Back to current month
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
