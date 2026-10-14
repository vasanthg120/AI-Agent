import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCalendar, FiChevronDown, FiChevronLeft, FiChevronRight, FiX } from 'react-icons/fi';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { DateRange } from './DateRangeControl';
import { POPUP_SPRING } from './motionPresets';
import styles from './DateRangePopup.module.css';

type Mode = 'months' | 'dates';

const DAY = 'YYYY-MM-DD';
const PANEL_WIDTH = 328;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// A "current" period runs from its start to today, never into the future —
// the same rule as the app's other date filters (see DateRangeControl.tsx).
const PRESETS: { id: string; label: string; range: (today: dayjs.Dayjs) => [dayjs.Dayjs, dayjs.Dayjs] }[] = [
  { id: 'thisMonth', label: 'This month', range: (t) => [t.startOf('month'), t] },
  {
    id: 'lastMonth',
    label: 'Last month',
    range: (t) => [t.subtract(1, 'month').startOf('month'), t.subtract(1, 'month').endOf('month')],
  },
  { id: 'last3', label: 'Last 3 months', range: (t) => [t.subtract(2, 'month').startOf('month'), t] },
  { id: 'last6', label: 'Last 6 months', range: (t) => [t.subtract(5, 'month').startOf('month'), t] },
  { id: 'thisYear', label: 'This year', range: (t) => [t.startOf('year'), t] },
  {
    id: 'lastYear',
    label: 'Last year',
    range: (t) => [t.subtract(1, 'year').startOf('year'), t.subtract(1, 'year').endOf('year')],
  },
];

const toRange = ([from, to]: [dayjs.Dayjs, dayjs.Dayjs]): DateRange => ({
  dateFrom: from.format(DAY),
  dateTo: to.format(DAY),
});

function presetFor(value: DateRange, today: dayjs.Dayjs) {
  return PRESETS.find((preset) => {
    const range = toRange(preset.range(today));
    return range.dateFrom === value.dateFrom && range.dateTo === value.dateTo;
  });
}

// A span that starts on the 1st and ends on a month's last day — or today, for the month still running.
function isWholeMonths(from: dayjs.Dayjs, to: dayjs.Dayjs, today: dayjs.Dayjs): boolean {
  return from.date() === 1 && (to.isSame(to.endOf('month'), 'day') || to.isSame(today, 'day'));
}

// Whole months read as months ("Sep – Oct 2026"), anything else as dates ("3 Sep – 6 Oct 2026").
function describe(value: DateRange, today: dayjs.Dayjs, emptyLabel: string): string {
  if (!value.dateFrom && !value.dateTo) return emptyLabel;
  const preset = presetFor(value, today);
  if (preset) return preset.label;
  const from = value.dateFrom ? dayjs(value.dateFrom) : null;
  const to = value.dateTo ? dayjs(value.dateTo) : null;
  if (!from) return `Until ${to!.format('D MMM YYYY')}`;
  if (!to) return `Since ${from.format('D MMM YYYY')}`;
  if (isWholeMonths(from, to, today)) {
    if (from.isSame(to, 'month')) return from.format('MMM YYYY');
    return from.isSame(to, 'year')
      ? `${from.format('MMM')} – ${to.format('MMM YYYY')}`
      : `${from.format('MMM YYYY')} – ${to.format('MMM YYYY')}`;
  }
  if (from.isSame(to, 'day')) return from.format('D MMM YYYY');
  if (from.isSame(to, 'month')) return `${from.format('D')} – ${to.format('D MMM YYYY')}`;
  return from.isSame(to, 'year')
    ? `${from.format('D MMM')} – ${to.format('D MMM YYYY')}`
    : `${from.format('D MMM YYYY')} – ${to.format('D MMM YYYY')}`;
}

// A start and an end, chosen the way people think about periods: a quick
// range ("Last 3 months"), a span of months, or two exact dates. One button
// shows what is selected; the panel applies each choice as it is made.
//
// Picking a span takes two clicks — the start, then the end, in either order —
// and the span is previewed while the pointer moves. Nothing in the future can
// be picked. Consumers decide which date the range filters on; this control is
// unaware of it (same contract as DateRangeControl / MonthYearFilterPopup).
export function DateRangePopup({
  value,
  onChange,
  emptyLabel = 'All time',
  ariaLabel = 'Period',
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  // What the button says when no period is chosen.
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('months');
  // The month (dates view) or year (months view) on show.
  const [cursor, setCursor] = useState(() => dayjs().startOf('month'));
  // The first of the two clicks, waiting for the second; and where the pointer is, for the preview.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Keeps the panel inside the window wherever the button sits.
  const [placement, setPlacement] = useState({ left: 0, width: PANEL_WIDTH });

  const today = dayjs();
  const isSet = !!(value.dateFrom || value.dateTo);
  const activePreset = presetFor(value, today);

  const close = () => {
    setOpen(false);
    setAnchor(null);
    setHover(null);
  };
  useClickOutside(wrapperRef, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 32);
    const left = Math.min(Math.max(rect.left, 16), window.innerWidth - 16 - width) - rect.left;
    setPlacement({ left, width });
  }, [open]);

  const toggle = () => {
    if (open) return close();
    // Open on what is selected: its end, and the view that matches how it was chosen.
    const end = value.dateTo ? dayjs(value.dateTo) : today;
    setCursor(end.startOf('month'));
    const exactDates = !!value.dateFrom && !!value.dateTo && !isWholeMonths(dayjs(value.dateFrom), end, today);
    setMode(exactDates ? 'dates' : 'months');
    setOpen(true);
  };

  const apply = (range: DateRange) => {
    onChange(range);
    setAnchor(null);
    setHover(null);
  };

  // ---- two clicks make a span; `key` is a day (YYYY-MM-DD) or a month (YYYY-MM)
  const pick = (key: string) => {
    if (!anchor) {
      setAnchor(key);
      setHover(key);
      return;
    }
    const [first, last] = anchor <= key ? [anchor, key] : [key, anchor];
    if (mode === 'months') {
      const end = dayjs(`${last}-01`).endOf('month');
      apply({ dateFrom: `${first}-01`, dateTo: (end.isAfter(today) ? today : end).format(DAY) });
    } else {
      apply({ dateFrom: first, dateTo: last });
    }
  };

  // "Done" after a single click means just that month, or just that day.
  const finish = () => {
    if (anchor) pick(anchor);
    close();
  };

  // What is highlighted: the span being picked, else the one in force.
  const unit = mode === 'months' ? 7 : 10;
  const preview = anchor
    ? [anchor, hover ?? anchor].sort()
    : [value.dateFrom?.slice(0, unit) ?? '', value.dateTo?.slice(0, unit) ?? value.dateFrom?.slice(0, unit) ?? ''];
  const [spanStart, spanEnd] = preview;
  const cellState = (key: string) => ({
    [styles.inSpan]: !!spanStart && key > spanStart && key < spanEnd,
    [styles.spanEdge]: !!spanStart && (key === spanStart || key === spanEnd),
    [styles.spanStart]: !!spanStart && key === spanStart && spanStart !== spanEnd,
    [styles.spanEnd]: !!spanStart && key === spanEnd && spanStart !== spanEnd,
  });

  const step = (amount: number) => setCursor((c) => c.add(amount, mode === 'months' ? 'year' : 'month'));
  const canStepForward = mode === 'months' ? cursor.year() < today.year() : cursor.isBefore(today, 'month');

  // The weeks of the month on show, padded to whole weeks.
  const firstCell = cursor.startOf('month').startOf('week');
  const weeks = Math.ceil((cursor.startOf('month').day() + cursor.daysInMonth()) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => firstCell.add(i, 'day'));

  const hint = anchor
    ? `Now pick the ${mode === 'months' ? 'last month' : 'end date'}, or Done for just this one`
    : mode === 'months'
      ? 'Pick the first month, then the last'
      : 'Pick the start date, then the end';

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, isSet && styles.triggerSet)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${describe(value, today, emptyLabel)}`}
        onClick={toggle}
      >
        <FiCalendar aria-hidden />
        <span>{describe(value, today, emptyLabel)}</span>
        <FiChevronDown aria-hidden className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>
      {isSet && (
        <button
          type="button"
          className={styles.clear}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => {
            apply({});
            close();
          }}
        >
          <FiX aria-hidden />
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={`Choose ${ariaLabel.toLowerCase()}`}
            className={styles.panel}
            style={{ left: placement.left, width: placement.width }}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={POPUP_SPRING}
          >
            <div className={styles.presets}>
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={clsx(styles.preset, activePreset?.id === preset.id && styles.presetActive)}
                  aria-pressed={activePreset?.id === preset.id}
                  onClick={() => {
                    apply(toRange(preset.range(today)));
                    close();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className={styles.modes} role="tablist" aria-label="Choose by">
              {(['months', 'dates'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mode === id}
                  className={clsx(styles.mode, mode === id && styles.modeActive)}
                  onClick={() => {
                    setMode(id);
                    setAnchor(null);
                    setHover(null);
                  }}
                >
                  {id === 'months' ? 'Months' : 'Dates'}
                </button>
              ))}
            </div>

            <div className={styles.nav}>
              <button type="button" className={styles.navButton} aria-label="Earlier" onClick={() => step(-1)}>
                <FiChevronLeft aria-hidden />
              </button>
              <strong aria-live="polite">{mode === 'months' ? cursor.year() : cursor.format('MMMM YYYY')}</strong>
              <button
                type="button"
                className={styles.navButton}
                aria-label="Later"
                disabled={!canStepForward}
                onClick={() => step(1)}
              >
                <FiChevronRight aria-hidden />
              </button>
            </div>

            {mode === 'months' ? (
              <div className={styles.monthGrid} onMouseLeave={() => anchor && setHover(anchor)}>
                {MONTHS.map((name, index) => {
                  const key = `${cursor.year()}-${String(index + 1).padStart(2, '0')}`;
                  const future = key > today.format('YYYY-MM');
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={future}
                      aria-label={`${dayjs(`${key}-01`).format('MMMM YYYY')}`}
                      aria-pressed={key === spanStart || key === spanEnd}
                      className={clsx(
                        styles.cell,
                        styles.monthCell,
                        cellState(key),
                        key === today.format('YYYY-MM') && styles.now,
                      )}
                      onClick={() => pick(key)}
                      onMouseEnter={() => anchor && setHover(key)}
                      onFocus={() => anchor && setHover(key)}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div onMouseLeave={() => anchor && setHover(anchor)}>
                <div className={styles.weekdays} aria-hidden>
                  {WEEKDAYS.map((name) => (
                    <span key={name}>{name}</span>
                  ))}
                </div>
                <div className={styles.dayGrid}>
                  {days.map((date) => {
                    const key = date.format(DAY);
                    const outside = !date.isSame(cursor, 'month');
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={date.isAfter(today, 'day')}
                        aria-label={date.format('D MMMM YYYY')}
                        aria-pressed={key === spanStart || key === spanEnd}
                        className={clsx(
                          styles.cell,
                          styles.dayCell,
                          cellState(key),
                          outside && styles.outside,
                          date.isSame(today, 'day') && styles.now,
                        )}
                        onClick={() => pick(key)}
                        onMouseEnter={() => anchor && setHover(key)}
                        onFocus={() => anchor && setHover(key)}
                      >
                        {date.date()}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className={styles.footer}>
              <span className={styles.hint}>{hint}</span>
              <span className={styles.footerActions}>
                {isSet && (
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => {
                      apply({});
                      close();
                    }}
                  >
                    {emptyLabel}
                  </button>
                )}
                <button type="button" className={clsx(styles.textButton, styles.done)} onClick={finish}>
                  Done
                </button>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
