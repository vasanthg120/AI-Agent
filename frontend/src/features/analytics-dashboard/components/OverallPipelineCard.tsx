import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { FiAlertCircle, FiChevronRight, FiLayers } from 'react-icons/fi';
import { AnimatedNumber, EmptyState, SectionCard, Skeleton } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import pageStyles from '../analytics-dashboard.module.css';
import styles from './OverallPipelineCard.module.css';

// Which open deals a click asks to see: all of them, or one month's.
export interface PipelineDeals {
  title: string;
  range: 'all' | { dateFrom: string; dateTo: string };
}

const deals = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'deal' : 'deals'}`;
const monthName = (period: string) => dayjs(`${period}-01`).format('MMM YYYY');

// The open pipeline of every month at once. Everything else on the dashboard
// follows the one month chosen at the top; an open deal that was expected to
// close in an earlier month is in none of those figures, yet it is still
// pipeline. Here every open deal is counted, by the month it is expected to
// close in — with what should already have closed set apart, because that is
// the part that needs chasing. A click on the total or on a month opens the
// deals behind it.
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

  const thisPeriod = dayjs().format('YYYY-MM');
  const months = data?.months ?? [];
  const sum = (list: { count: number; value: number }[]) =>
    list.reduce((total, m) => ({ count: total.count + m.count, value: total.value + m.value }), { count: 0, value: 0 });
  // Expected to close in a month that is over, and still open.
  const past = sum(months.filter((m) => m.period < thisPeriod));
  const ahead = sum(months.filter((m) => m.period >= thisPeriod));
  const largest = Math.max(1, ...months.map((m) => m.value), data?.undated.value ?? 0);
  const withDeals = months.filter((m) => m.count > 0).length;

  return (
    <SectionCard title="Overall Pipeline — All Months" icon={FiLayers} glass>
      <p className={pageStyles.sectionNote}>
        Every open deal, by the month it is expected to close. The rest of this dashboard follows the month chosen above
        — this section always shows all months.
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
          title="No open deals"
          description="Nothing is in the pipeline right now: every deal is won or lost."
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
                {deals(data.totalCount)} open · across {withDeals} {withDeals === 1 ? 'month' : 'months'}
              </span>
              <FiChevronRight aria-hidden className={styles.totalArrow} />
            </button>

            <div className={styles.split}>
              <div className={clsx(styles.tile, past.count > 0 && styles.tilePast)}>
                <span>Expected to close before {monthName(thisPeriod)}</span>
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

          <ul className={styles.months} aria-label="Open pipeline by month">
            {months.map((month, index) => {
              const isPast = month.period < thisPeriod && month.count > 0;
              const label = monthName(month.period);
              return (
                <li key={month.period}>
                  <button
                    type="button"
                    className={clsx(
                      styles.month,
                      isPast && styles.monthPast,
                      month.period === selectedPeriod && styles.monthSelected,
                    )}
                    disabled={month.count === 0}
                    aria-label={
                      month.count === 0
                        ? `${label}: no open deals`
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
                      {month.period === thisPeriod && (
                        <span className={clsx(styles.tag, styles.tagNow)}>This month</span>
                      )}
                      {isPast && <span className={clsx(styles.tag, styles.tagPast)}>Past due</span>}
                    </span>
                    <span className={styles.track} aria-hidden>
                      <motion.span
                        className={styles.fill}
                        initial={{ width: 0 }}
                        animate={{ width: `${(month.value / largest) * 100}%` }}
                        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: Math.min(index, 12) * 0.03 }}
                      />
                    </span>
                    <strong className={styles.amount}>{money(month.value)}</strong>
                    <span className={styles.count}>{month.count === 0 ? 'No deals' : deals(month.count)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
