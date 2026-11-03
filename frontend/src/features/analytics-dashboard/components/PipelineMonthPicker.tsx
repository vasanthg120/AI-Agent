import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCalendar, FiChevronDown, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { POPUP_SPRING } from '@/components/ui/motionPresets';
import { useClickOutside } from '@/hooks/useClickOutside';
import styles from './OverallPipelineCard.module.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface PipelineMonthPickerProps {
  // What the button reads: the months on show, e.g. "Jul – Nov 2026".
  label: string;
  // The month marked as chosen ("YYYY-MM").
  value: string;
  // The months there is anything to see in. Anything outside them can't be chosen.
  min: string;
  max: string;
  // The month it is today, marked so it's easy to find.
  today: string;
  // Months with open deals, each marked with a dot.
  withDeals: Set<string>;
  onChange: (period: string) => void;
}

// A month and year, chosen from a calendar-style grid.
export function PipelineMonthPicker({ label, value, min, max, today, withDeals, onChange }: PipelineMonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(value.slice(0, 4)));
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(rootRef, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const minYear = Number(min.slice(0, 4));
  const maxYear = Number(max.slice(0, 4));

  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        type="button"
        className={styles.rangeButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Months shown: ${label}. Choose a month`}
        onClick={() => {
          if (!open) setYear(Number(value.slice(0, 4)));
          setOpen((current) => !current);
        }}
      >
        <FiCalendar aria-hidden className={styles.rangeIcon} />
        <span className={styles.rangeText}>{label}</span>
        <FiChevronDown aria-hidden className={clsx(styles.rangeChevron, open && styles.rangeChevronOpen)} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.popover}
            role="dialog"
            aria-label="Choose a month"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            <div className={styles.popoverYear}>
              <button
                type="button"
                className={styles.yearButton}
                aria-label="Previous year"
                disabled={year <= minYear}
                onClick={() => setYear(year - 1)}
              >
                <FiChevronLeft aria-hidden />
              </button>
              <strong>{year}</strong>
              <button
                type="button"
                className={styles.yearButton}
                aria-label="Next year"
                disabled={year >= maxYear}
                onClick={() => setYear(year + 1)}
              >
                <FiChevronRight aria-hidden />
              </button>
            </div>

            <div className={styles.monthGrid}>
              {MONTHS.map((name, index) => {
                const period = `${year}-${String(index + 1).padStart(2, '0')}`;
                const outside = period < min || period > max;
                return (
                  <button
                    key={period}
                    type="button"
                    className={clsx(
                      styles.monthCell,
                      period === value && styles.monthCellChosen,
                      period === today && styles.monthCellToday,
                    )}
                    disabled={outside}
                    aria-pressed={period === value}
                    aria-label={`${name} ${year}${withDeals.has(period) ? ', has open deals' : ''}`}
                    onClick={() => {
                      onChange(period);
                      setOpen(false);
                    }}
                  >
                    {name}
                    <span className={clsx(styles.monthDot, withDeals.has(period) && styles.monthDotOn)} aria-hidden />
                  </button>
                );
              })}
            </div>
            <p className={styles.popoverHint}>
              <span className={clsx(styles.monthDot, styles.monthDotOn)} aria-hidden /> Has open deals
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
