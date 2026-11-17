import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Skeleton } from '@/components/ui';
import { teamActivityService, type TeamPeriodValue, type TeamTrendPoint } from '@/services/teamActivityService';
import styles from './TeamActivity.module.css';

type Series = 'calls' | 'talk' | 'emails' | 'deals';

const SERIES: { id: Series; label: string; bars: { key: keyof TeamTrendPoint | 'talkMinutes'; name: string; color: string }[] }[] = [
  { id: 'calls', label: 'Calls', bars: [{ key: 'calls', name: 'Calls', color: 'var(--brand-accent-primary)' }] },
  { id: 'talk', label: 'Talk time', bars: [{ key: 'talkMinutes', name: 'Minutes on calls', color: 'var(--brand-accent-primary)' }] },
  {
    id: 'emails',
    label: 'Emails',
    bars: [
      { key: 'emailsSent', name: 'Sent', color: 'var(--brand-accent-primary)' },
      { key: 'emailsReplied', name: 'Replied to customers', color: 'var(--color-info)' },
    ],
  },
  {
    id: 'deals',
    label: 'Deals',
    bars: [
      { key: 'dealsCreated', name: 'Created', color: 'var(--brand-accent-primary)' },
      { key: 'dealsWon', name: 'Won', color: 'var(--color-success)' },
    ],
  },
];

// Day by day (week by week past two months): what the team — or one person —
// did. A single day has no trend, so Today/Yesterday show the last 7 days.
export function TeamTrendChart({ period, filters }: { period: TeamPeriodValue; filters: { organizationId?: string; userId?: string } }) {
  const [series, setSeries] = useState<Series>('calls');
  const single = period.period === 'today' || period.period === 'yesterday' || (period.period === 'custom' && (!period.to || period.to === period.from));
  const effective: TeamPeriodValue = single ? { period: 'last7' } : period;
  const { data, isLoading } = useQuery({
    queryKey: ['team-activity-trend', effective, filters],
    queryFn: () => teamActivityService.trend(effective, filters),
    placeholderData: keepPreviousData,
  });
  const chosen = SERIES.find((s) => s.id === series)!;
  const rows = (data?.points ?? []).map((p) => ({
    ...p,
    talkMinutes: Math.round(p.talkSeconds / 60),
    tick: data?.granularity === 'week' ? `w/c ${dayjs(p.date).format('D MMM')}` : dayjs(p.date).format(single || (data?.points.length ?? 0) <= 8 ? 'ddd D' : 'D MMM'),
  }));

  return (
    <div className={styles.trend}>
      <div className={styles.trendBar}>
        <span className={styles.trendNote}>{single ? 'Last 7 days, day by day' : data?.granularity === 'week' ? 'Week by week' : 'Day by day'}</span>
        <div className={styles.subTabs} role="tablist" aria-label="Which trend">
          {SERIES.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={series === s.id} className={clsx(styles.subTab, series === s.id && styles.subTabActive)} onClick={() => setSeries(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <Skeleton height={220} />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="tick" stroke="var(--color-text-muted)" fontSize={11} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis stroke="var(--color-text-muted)" fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} width={40} />
            <Tooltip
              cursor={{ fill: 'var(--color-bg-hover)' }}
              contentStyle={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 12 }}
              labelFormatter={(_, payload) => {
                const point = payload?.[0]?.payload as (TeamTrendPoint & { date: string }) | undefined;
                if (!point) return '';
                return data?.granularity === 'week' ? `Week of ${dayjs(point.date).format('D MMM YYYY')}` : dayjs(point.date).format('dddd D MMM YYYY');
              }}
            />
            {chosen.bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />}
            {chosen.bars.map((b) => (
              <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color} radius={[4, 4, 0, 0]} maxBarSize={28} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
