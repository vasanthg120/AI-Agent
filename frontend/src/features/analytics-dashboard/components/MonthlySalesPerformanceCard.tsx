import dayjs from 'dayjs';
import clsx from 'clsx';
import { FiArrowDown, FiArrowUp, FiChevronRight } from 'react-icons/fi';
import { AnimatedNumber, Card, Badge, InfoPopover } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import type { PreviousMonthClosures } from '@/services/analyticsDashboardService';
import styles from './MonthlySalesPerformanceCard.module.css';

export interface MonthlySalesPerformanceCardProps {
  achieved: number;
  targetAmount: number | null;
  achievementPct: number | null;
  remaining: number | null;
  predictedMonthEnd: number;
  // Trailing months ending on the selected month, oldest→newest — the exact
  // shape AnalyticsDashboardOverview.revenueTrend already returns. The
  // month-over-month trend below is computed from its own last two points
  // (real, already-fetched data), never invented.
  revenueTrend: { period: string; achieved: number }[];
  // The selected reporting-period bounds — real inputs, not the current
  // calendar date, so this reads correctly for a past month too (100%
  // elapsed, not "19 of 31"). Used only for the days-elapsed/run-rate footer
  // and the on-track/off-track pace comparison.
  dateFrom: string;
  dateTo: string;
  onClick?: () => void;
  // Won deals that started the month before and were closed in this one — a
  // band of its own at the bottom; nothing else on the card reads it.
  previousMonthClosures?: PreviousMonthClosures;
  onOpenPreviousMonthClosures?: () => void;
}

const monthName = (period: string) => dayjs(`${period}-01`).format('MMMM');

// How the listed deals relate to the revenue figure above: inside it (closing
// date this month), outside it (closing date in another month), or a mix.
function closuresNote(data: PreviousMonthClosures, achieved: number): string {
  const month = monthName(data.period);
  if (data.count === 0) return `No deal that started in ${monthName(data.previousPeriod)} was won in ${month}.`;

  const inRevenue = `${month}'s ${money(achieved)}`;
  const otherMonths = new Set(
    data.deals.filter((d) => d.revenuePeriod && d.revenuePeriod !== data.period).map((d) => monthName(d.revenuePeriod!)),
  );
  const elsewhere = otherMonths.size === 1 ? `${[...otherMonths][0]}'s revenue` : "other months' revenue";

  if (data.outsideThisMonthRevenue.count === 0) return `Already part of ${inRevenue} above — shown here, not added again.`;
  if (data.inThisMonthRevenue.count === 0) return `Not part of ${inRevenue} — by closing date it counts in ${elsewhere}.`;
  return (
    `${money(data.inThisMonthRevenue.value)} is part of ${inRevenue} above; ` +
    `${money(data.outsideThisMonthRevenue.value)} counts in ${elsewhere} by closing date.`
  );
}

function PreviousMonthClosuresBand({
  data,
  achieved,
  onOpen,
}: {
  data: PreviousMonthClosures;
  achieved: number;
  onOpen?: () => void;
}) {
  const month = monthName(data.period);
  const previous = monthName(data.previousPeriod);
  const title = `${previous} deals closed in ${month}`;
  const clickable = data.count > 0 && !!onOpen;
  const unknown = data.unknownStart;

  return (
    <div
      className={clsx(styles.carryOver, clickable && styles.carryOverClickable)}
      onClick={(event) => {
        // Opens its own list, never the card's won-deals one underneath.
        event.stopPropagation();
        if (clickable) onOpen?.();
      }}
    >
      <div className={styles.carryOverHead}>
        <span className={styles.miniLabel}>{title}</span>
        <InfoPopover title={title} align="right" placement="top">
          <div>
            Won deals that started in {previous} and were closed in {month}. Shown on their own — never added to the
            revenue, target, forecast or daily figures above.
          </div>
          <div>
            <strong>Revenue month</strong> — the figure above counts a won deal in the month of its closing date: the
            day it was marked won, unless the CRM sent its own date. That hasn&apos;t changed.
          </div>
          <div>
            <strong>Started</strong> — the earliest date the deal or one of its quotes was recorded.{' '}
            <strong>Closed</strong> — when HaiVE saw it marked won; deals won before HaiVE recorded that use their
            closing date.
          </div>
          <div>A reopened deal drops out; a deal closed twice counts once, in the month it last closed.</div>
          {unknown.count > 0 && (
            <div>
              {unknown.count} won {unknown.count === 1 ? 'deal' : 'deals'} closed in {month} ({money(unknown.value)}){' '}
              {unknown.count === 1 ? "isn't" : "aren't"} listed: HaiVE first saw {unknown.count === 1 ? 'it' : 'them'}{' '}
              in the CRM&apos;s first import, and nothing earlier shows when {unknown.count === 1 ? 'it' : 'they'}{' '}
              started.
            </div>
          )}
        </InfoPopover>
      </div>
      <div className={styles.carryOverRow}>
        <span className={styles.carryOverValue}>{money(data.value)}</span>
        <span className={styles.trendMeta}>
          · {data.count} {data.count === 1 ? 'deal' : 'deals'}
        </span>
        {clickable && (
          <button type="button" className={styles.carryOverLink}>
            View {data.count === 1 ? 'deal' : 'deals'} <FiChevronRight size={13} />
          </button>
        )}
      </div>
      <div className={styles.carryOverNote}>{closuresNote(data, achieved)}</div>
    </div>
  );
}

// The one hero KPI on the Overview tab. On-track/off-track, the forecast
// segment, and the days-elapsed/run-rate footer are all derived straight
// from real fields already on this card (dateFrom/dateTo + the revenue
// figures) — nothing here is invented or hardcoded.
export function MonthlySalesPerformanceCard({
  achieved,
  targetAmount,
  achievementPct,
  remaining,
  predictedMonthEnd,
  revenueTrend,
  dateFrom,
  dateTo,
  onClick,
  previousMonthClosures,
  onOpenPreviousMonthClosures,
}: MonthlySalesPerformanceCardProps) {
  const current = revenueTrend[revenueTrend.length - 1];
  const previous = revenueTrend[revenueTrend.length - 2];
  const trend =
    previous && previous.achieved > 0
      ? { direction: current.achieved >= previous.achieved ? ('up' as const) : ('down' as const), pct: Math.abs(((current.achieved - previous.achieved) / previous.achieved) * 100) }
      : null;

  const start = dayjs(dateFrom);
  const end = dayjs(dateTo);
  const totalDaysInMonth = start.daysInMonth();
  const daysElapsed = Math.min(Math.max(end.date(), 1), totalDaysInMonth);
  const daysRemaining = Math.max(0, totalDaysInMonth - daysElapsed);
  const runRatePerDay = achieved / daysElapsed;
  const neededPerDay = remaining !== null && daysRemaining > 0 ? remaining / daysRemaining : null;

  // "On track" if achievement-so-far is keeping pace with how much of the
  // month has elapsed (a 10% cushion — flat month-start dips shouldn't flip
  // this the moment the month opens).
  const expectedPct = targetAmount !== null ? (daysElapsed / totalDaysInMonth) * 100 : null;
  const onTrack = achievementPct !== null && expectedPct !== null ? achievementPct >= expectedPct * 0.9 : null;

  const barBasis = targetAmount ?? 0;
  const achievedBarPct = barBasis > 0 ? Math.max(0, Math.min(100, (achieved / barBasis) * 100)) : 0;
  const predictedBarPct = barBasis > 0 ? Math.max(0, Math.min(100, (predictedMonthEnd / barBasis) * 100)) : 0;
  const forecastBarPct = Math.max(0, predictedBarPct - achievedBarPct);

  return (
    <Card interactive={!!onClick} onClick={onClick} className={styles.card}>
      <div className={styles.topRow}>
        <div>
          <div className={styles.title}>Revenue against target</div>
          <div className={styles.subtitle}>Sales targets are set per calendar month.</div>
        </div>
        {onTrack !== null && <Badge variant={onTrack ? 'success' : 'danger'}>{onTrack ? 'On track' : 'Off track'}</Badge>}
      </div>

      <div className={styles.mainRow}>
        <div className={styles.mainCol}>
          <div className={styles.bigValue}>
            <AnimatedNumber value={achieved} format={money} />
          </div>
          <div className={styles.trendLine}>
            {trend && (
              <span className={clsx(styles.trend, trend.direction === 'up' ? styles.trendUp : styles.trendDown)}>
                {trend.direction === 'up' ? <FiArrowUp size={12} /> : <FiArrowDown size={12} />}
                {trend.pct.toFixed(1)}% vs last month
              </span>
            )}
            {achievementPct !== null && targetAmount !== null && (
              <span className={styles.trendMeta}>
                {trend && ' · '}
                {achievementPct}% of {money(targetAmount)}
              </span>
            )}
          </div>
        </div>
        {remaining !== null && (
          <div className={styles.sideStat}>
            <span className={styles.miniLabel}>Remaining</span>
            <span className={styles.miniValue}>{money(remaining)}</span>
          </div>
        )}
      </div>

      <div className={styles.predictedRow}>
        <span className={styles.miniLabel}>Predicted month-end</span>
        <span className={styles.miniValue}>{money(predictedMonthEnd)}</span>
      </div>

      {targetAmount !== null && (
        <>
          <div className={styles.progressTrack}>
            <div className={styles.progressAchieved} style={{ width: `${achievedBarPct}%` }} />
            <div className={styles.progressForecast} style={{ width: `${forecastBarPct}%`, left: `${achievedBarPct}%` }} />
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <i className={clsx(styles.dot, styles.dotAchieved)} /> Achieved {money(achieved)}
            </span>
            <span className={styles.legendItem}>
              <i className={clsx(styles.dot, styles.dotForecast)} /> Forecast {money(predictedMonthEnd)}
            </span>
            <span className={styles.legendItem}>
              <i className={clsx(styles.dot, styles.dotTarget)} /> Target {money(targetAmount)}
            </span>
          </div>
        </>
      )}

      <div className={styles.footerDivider} />
      <div className={styles.footerRow}>
        <div>
          <div className={styles.miniLabel}>Days elapsed</div>
          <div className={styles.miniValue}>
            {daysElapsed} of {totalDaysInMonth}
          </div>
        </div>
        <div>
          <div className={styles.miniLabel}>Run rate / day</div>
          <div className={styles.miniValue}>{money(runRatePerDay)}</div>
        </div>
        <div>
          <div className={styles.miniLabel}>Needed / day</div>
          <div className={styles.miniValue}>{neededPerDay !== null ? money(neededPerDay) : '—'}</div>
        </div>
      </div>

      {previousMonthClosures && (
        <PreviousMonthClosuresBand data={previousMonthClosures} achieved={achieved} onOpen={onOpenPreviousMonthClosures} />
      )}
    </Card>
  );
}
