import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { AreaChart, Area, XAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { FiArrowUpRight, FiArrowDownRight } from 'react-icons/fi';
import { Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './RevenueMomentumCard.module.css';

export interface RevenueMomentumCardProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Day-by-day series for the selected reporting period — there's no daily-
// granularity endpoint anywhere in this app (only monthly trends), so this
// fetches the same real won-deal records the drill-down modal already shows
// (dealsService.listFiltered) and buckets them by expectedClosingDate
// client-side. Every point is a real deal total, never invented; days with
// no won deals genuinely show zero rather than being skipped, so the chart
// doesn't imply activity that didn't happen.
export function RevenueMomentumCard({ dateFrom, dateTo, storeId }: RevenueMomentumCardProps) {
  const [showDeals, setShowDeals] = useState(false);
  const { data: wonDeals, isLoading } = useQuery({
    queryKey: ['analytics-revenue-momentum', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['won'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
  });

  const { series, total, momentumPct } = useMemo(() => {
    const byDay = new Map<string, number>();
    let cursor = dayjs(dateFrom);
    const end = dayjs(dateTo);
    while (!cursor.isAfter(end)) {
      byDay.set(cursor.format('YYYY-MM-DD'), 0);
      cursor = cursor.add(1, 'day');
    }
    for (const deal of wonDeals?.items ?? []) {
      if (!deal.expectedClosingDate || !byDay.has(deal.expectedClosingDate)) continue;
      byDay.set(deal.expectedClosingDate, (byDay.get(deal.expectedClosingDate) ?? 0) + deal.monetaryValue);
    }
    const points = [...byDay.entries()].map(([date, value]) => ({ date, value }));
    const totalValue = points.reduce((s, p) => s + p.value, 0);

    // Momentum = second half of the period vs the first half, both real
    // sums from the same series — not a hardcoded window, so it degrades
    // gracefully (null, hidden) for a period too short to compare.
    const mid = Math.floor(points.length / 2);
    const firstHalf = points.slice(0, mid).reduce((s, p) => s + p.value, 0);
    const secondHalf = points.slice(mid).reduce((s, p) => s + p.value, 0);
    const pct = mid > 0 && firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : null;

    return { series: points, total: totalValue, momentumPct: pct };
  }, [wonDeals, dateFrom, dateTo]);

  const dealRows: DrillDownRow[] = (wonDeals?.items ?? []).map((d) => ({
    id: d._id,
    title: d.name,
    subtitle: d.expectedClosingDate,
    value: d.monetaryValue,
  }));

  return (
    <Card className={styles.card} interactive={series.length > 1} onClick={series.length > 1 ? () => setShowDeals(true) : undefined}>
      <div className={styles.label}>Performance Signal</div>
      <div className={styles.title}>
        Revenue momentum
      </div>

      <div className={styles.valueRow}>
        <span className={styles.value}>{money(total)}</span>
        {momentumPct !== null && (
          <span className={clsx(styles.momentum, momentumPct >= 0 ? styles.up : styles.down)}>
            {momentumPct >= 0 ? <FiArrowUpRight size={13} /> : <FiArrowDownRight size={13} />}
            {Math.abs(momentumPct).toFixed(1)}%
          </span>
        )}
      </div>

      {!isLoading && series.length > 1 && (
        <div className={styles.chartWrap}>
          <ResponsiveContainer width="100%" height={150}>
            <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
              <defs>
                <linearGradient id="momentumFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand-accent-primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--brand-accent-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => dayjs(d).format('MMM DD')}
                stroke="var(--color-text-muted)"
                fontSize={11}
                interval="preserveStartEnd"
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <Tooltip
                formatter={(v: number) => money(v)}
                labelFormatter={(d: string) => dayjs(d as string).format('MMM D, YYYY')}
                contentStyle={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-text-primary)',
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--brand-accent-primary)"
                strokeWidth={2.5}
                fill="url(#momentumFill)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <DrillDownModal
        open={showDeals}
        onClose={() => setShowDeals(false)}
        title="Won Deals in This Period"
        isLoading={isLoading}
        rows={dealRows}
      />
    </Card>
  );
}
