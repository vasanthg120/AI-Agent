import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { FiAlertCircle, FiChevronLeft, FiChevronRight, FiLayers } from 'react-icons/fi';
import { AnimatedNumber, EmptyState, SectionCard, Skeleton } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import { PipelineMonthPicker } from './PipelineMonthPicker';
import pageStyles from '../analytics-dashboard.module.css';
import styles from './OverallPipelineCard.module.css';

// Which open deals a click asks to see: all of them, or one month's.
export interface PipelineDeals {
  title: string;
  range: 'all' | { dateFrom: string; dateTo: string };
}

const VISIBLE_MONTHS = 5;
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

const deals = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'deal' : 'deals'}`;
const monthName = (period: string) => dayjs(`${period}-01`).format('MMM YYYY');
const addMonths = (period: string, by: number) => dayjs(`${period}-01`).add(by, 'month').format('YYYY-MM');

function rangeLabel(from: string, to: string): string {
  if (from === to) return monthName(to);
  const start = dayjs(`${from}-01`);
  const end = dayjs(`${to}-01`);
  return start.year() === end.year() ? `${start.format('MMM')} – ${end.format('MMM YYYY')}` : `${start.format('MMM YYYY')} – ${end.format('MMM YYYY')}`;
}

// A row arrives from the side the list is moving towards, and leaves by the other.
const ROW = {
  enter: (direction: number) => ({ opacity: 0, y: direction * 18 }),
  shown: { opacity: 1, y: 0 },
  leave: (direction: number) => ({ opacity: 0, y: direction * -18 }),
};

// The open pipeline across every month. Everything else on the dashboard follows
// the one month chosen at the top; an open deal that was expected to close in an
// earlier month is in none of those figures, yet it is still pipeline. So the
// totals here cover every month, with what should already have closed set apart,
// while the list below shows five months at a time, the most recent first on
// opening, with its own controls to move through the rest. A click on the total or
// on a month opens the deals behind it.
export function OverallPipelineCard({
  storeId,
  selectedPeriod,
  onOpenDeals,
}: {
  storeId?: string;
  // The month chosen at the top of the dashboard ("YYYY-MM"): marked in the list.
  selectedPeriod: string;
  onOpenDeals: (target: PipelineDeals) => void;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['analytics-pipeline-by-month', storeId],
    queryFn: () => analyticsDashboardService.getPipelineByMonth(storeId),
    refetchInterval: 60_000,
  });

  // The last month on show, once someone has moved away from the most recent five.
  const [chosenEnd, setChosenEnd] = useState<string | null>(null);
  // A month picked from the calendar, marked in the list.
  const [picked, setPicked] = useState<string | null>(null);
  // Which way the list last moved, so rows slide the matching way.
  const [direction, setDirection] = useState(1);

  const thisPeriod = dayjs().format('YYYY-MM');
  const months = useMemo(() => data?.months ?? [], [data]);

  const sum = (list: { count: number; value: number }[]) =>
    list.reduce((total, m) => ({ count: total.count + m.count, value: total.value + m.value }), { count: 0, value: 0 });
  // Expected to close in a month that is over, and still open.
  const past = sum(months.filter((m) => m.period < thisPeriod));
  const ahead = sum(months.filter((m) => m.period >= thisPeriod));
  const withDeals = useMemo(() => new Set(months.filter((m) => m.count > 0).map((m) => m.period)), [months]);

  // The months there is anything to see in: every month with deals, and today's.
  const first = months[0]?.period ?? thisPeriod;
  const last = months[months.length - 1]?.period ?? thisPeriod;
  const earliest = first < thisPeriod ? first : thisPeriod;
  const latest = last > thisPeriod ? last : thisPeriod;
  // The window never runs off the oldest month, so it always shows five when there are five to show.
  const lowestEnd = addMonths(earliest, VISIBLE_MONTHS - 1) < latest ? addMonths(earliest, VISIBLE_MONTHS - 1) : latest;
  const clampEnd = (period: string) => (period < lowestEnd ? lowestEnd : period > latest ? latest : period);

  const homeEnd = clampEnd(thisPeriod);
  const windowEnd = clampEnd(chosenEnd ?? thisPeriod);
  const windowStart = addMonths(windowEnd, 1 - VISIBLE_MONTHS) > earliest ? addMonths(windowEnd, 1 - VISIBLE_MONTHS) : earliest;

  const visible = useMemo(() => {
    const byPeriod = new Map(months.map((m) => [m.period, m]));
    const rows: { period: string; count: number; value: number }[] = [];
    for (let period = windowStart; period <= windowEnd; period = addMonths(period, 1)) {
      rows.push(byPeriod.get(period) ?? { period, count: 0, value: 0 });
    }
    return rows;
  }, [months, windowStart, windowEnd]);

  const shown = sum(visible);
  // Each bar is against the largest on show, so the months in view can be told apart.
  const largest = Math.max(1, ...visible.map((m) => m.value));

  const moveTo = (end: string) => {
    setDirection(end >= windowEnd ? 1 : -1);
    setChosenEnd(end);
  };

  return (
    <SectionCard title="Overall Pipeline" icon={FiLayers} glass>
      <p className={pageStyles.sectionNote}>
        Everything in the pipeline, month by month: open deals by when they’re expected to close, and for Hoops its jobs in
        progress by the month they were won. This section has its own month controls and doesn’t follow
        the month chosen above.
      </p>

      {isLoading ? (
        <Skeleton height={220} />
      ) : isError || !data ? (
        <EmptyState
          compact
          icon={FiAlertCircle}
          title="Couldn’t load the pipeline"
          description={extractErrorMessage(error)}
        />
      ) : data.totalCount === 0 ? (
        <EmptyState
          compact
          icon={FiLayers}
          title="Nothing in the pipeline"
          description="No open deals, and no jobs in progress, right now."
        />
      ) : (
        <>
          <div className={styles.summary}>
            <button
              type="button"
              className={styles.total}
              title="Open the deals behind this figure"
              onClick={() => onOpenDeals({ title: 'Open Pipeline — All Months', range: 'all' })}
            >
              <span className={styles.totalLabel}>Total open pipeline</span>
              <span className={styles.totalValue}>
                <AnimatedNumber value={data.totalValue} format={money} />
              </span>
              <span className={styles.totalMeta}>
                {deals(data.totalCount)} open · across {withDeals.size} {withDeals.size === 1 ? 'month' : 'months'}
              </span>
              <FiChevronRight aria-hidden className={styles.totalArrow} />
            </button>

            <div className={styles.split}>
              <div className={clsx(styles.tile, past.count > 0 && styles.tilePast)}>
                <span>Past due, before {monthName(thisPeriod)}</span>
                <strong>{money(past.value)}</strong>
                <span>{past.count > 0 ? `${deals(past.count)} still open` : 'Nothing left open'}</span>
              </div>
              <div className={styles.tile}>
                <span>{monthName(thisPeriod)} onwards</span>
                <strong>{money(ahead.value)}</strong>
                <span>{deals(ahead.count)}</span>
              </div>
              {data.undated.count > 0 && (
                <div className={styles.tile}>
                  <span>No closing date set</span>
                  <strong>{money(data.undated.value)}</strong>
                  <span>{deals(data.undated.count)}</span>
                </div>
              )}
            </div>
          </div>

          <div className={styles.listHeader}>
            <div className={styles.listSummary} aria-live="polite">
              <span className={styles.listLabel}>
                {visible.length === 1 ? 'This month' : `These ${visible.length} months`}
              </span>
              <span className={styles.listValue}>
                <AnimatedNumber value={shown.value} format={money} />
                <span className={styles.listCount}>{deals(shown.count)}</span>
              </span>
            </div>

            <div className={styles.controls}>
              {windowEnd !== homeEnd && (
                <button
                  type="button"
                  className={styles.homeButton}
                  onClick={() => {
                    setPicked(null);
                    moveTo(homeEnd);
                  }}
                >
                  Latest
                </button>
              )}
              <div className={styles.stepper}>
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label="Earlier month"
                  disabled={windowEnd <= lowestEnd}
                  onClick={() => moveTo(addMonths(windowEnd, -1))}
                >
                  <FiChevronLeft aria-hidden />
                </button>
                <PipelineMonthPicker
                  label={rangeLabel(windowStart, windowEnd)}
                  value={picked ?? windowEnd}
                  min={earliest}
                  max={latest}
                  today={thisPeriod}
                  withDeals={withDeals}
                  onChange={(period) => {
                    setPicked(period);
                    // Only moves if that month isn't already on show.
                    if (period < windowStart || period > windowEnd) moveTo(period);
                  }}
                />
                <button
                  type="button"
                  className={styles.stepButton}
                  aria-label="Later month"
                  disabled={windowEnd >= latest}
                  onClick={() => moveTo(addMonths(windowEnd, 1))}
                >
                  <FiChevronRight aria-hidden />
                </button>
              </div>
            </div>
          </div>

          <ul className={styles.months} aria-label="Open pipeline by month">
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
              {visible.map((month, index) => {
                const isPast = month.period < thisPeriod && month.count > 0;
                const label = monthName(month.period);
                return (
                  <motion.li
                    key={month.period}
                    layout="position"
                    custom={direction}
                    variants={ROW}
                    initial="enter"
                    animate="shown"
                    exit="leave"
                    transition={{ duration: 0.32, ease: EASE }}
                  >
                    <button
                      type="button"
                      className={clsx(
                        styles.month,
                        isPast && styles.monthPast,
                        month.period === (picked ?? selectedPeriod) && styles.monthSelected,
                      )}
                      disabled={month.count === 0}
                      aria-label={
                        month.count === 0
                          ? `${label}: nothing in the pipeline`
                          : `${label}: ${money(month.value)} in ${deals(month.count)}. Open them`
                      }
                      onClick={() =>
                        onOpenDeals({
                          title: `Open Pipeline — ${label}`,
                          range: {
                            dateFrom: `${month.period}-01`,
                            dateTo: dayjs(`${month.period}-01`).endOf('month').format('YYYY-MM-DD'),
                          },
                        })
                      }
                    >
                      <span className={styles.monthName}>
                        {label}
                        {month.period === thisPeriod && <span className={clsx(styles.tag, styles.tagNow)}>This month</span>}
                        {isPast && <span className={clsx(styles.tag, styles.tagPast)}>Past due</span>}
                      </span>
                      <span className={styles.track} aria-hidden>
                        <motion.span
                          className={styles.fill}
                          initial={{ width: 0 }}
                          animate={{ width: `${(month.value / largest) * 100}%` }}
                          transition={{ duration: 0.6, ease: EASE, delay: index * 0.02 }}
                        />
                      </span>
                      <strong className={styles.amount}>{money(month.value)}</strong>
                      <span className={styles.count}>{month.count === 0 ? 'No deals' : deals(month.count)}</span>
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </>
      )}
    </SectionCard>
  );
}
