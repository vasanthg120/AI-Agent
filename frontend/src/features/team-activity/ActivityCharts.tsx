import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipProps } from 'recharts';
import { EmptyState, Skeleton } from '@/components/ui';
import { formatAmountIn } from '@/utils/currency';
import { formatTalkTime, teamActivityService, type TeamPeriodValue, type TeamTrendPoint, type TeamUsageReport } from '@/services/teamActivityService';
import { CHART_AREAS, SERIES, chartAreaOf, type ChartArea } from './usageAreas';
import styles from './EmployeeActivity.module.css';
import teamStyles from './TeamActivity.module.css';

export type TrendView = 'time' | 'calls' | 'emails' | 'deals' | 'revenue';

interface SeriesDef {
  key: string;
  name: string;
  color: string;
}

type Row = TeamTrendPoint & { tick: string; activeHours: number; notAnswered: number };

// Each view's series take the validated categorical slots in their fixed order;
// a lone series needs no legend (the view's name says what it is).
const VIEWS: Record<TrendView, { label: string; series: SeriesDef[]; format: (value: number, currency?: string | null) => string }> = {
  time: {
    label: 'Active time',
    series: [{ key: 'activeHours', name: 'Active time', color: SERIES[0] }],
    format: (v) => formatTalkTime(Math.round(v * 3600)),
  },
  calls: {
    label: 'Calls',
    series: [
      { key: 'callsMade', name: 'Outgoing', color: SERIES[0] },
      { key: 'callsReceived', name: 'Incoming', color: SERIES[1] },
      { key: 'notAnswered', name: 'Not answered', color: SERIES[2] },
    ],
    format: (v) => String(v),
  },
  emails: {
    label: 'Emails',
    series: [
      { key: 'emailsSent', name: 'Sent', color: SERIES[0] },
      { key: 'emailsReceived', name: 'Received', color: SERIES[1] },
      { key: 'emailsReplied', name: 'Replied to customers', color: SERIES[2] },
    ],
    format: (v) => String(v),
  },
  deals: {
    label: 'Deals',
    series: [
      { key: 'dealsCreated', name: 'Created', color: SERIES[0] },
      { key: 'dealsWon', name: 'Won', color: SERIES[1] },
      { key: 'dealsLost', name: 'Lost', color: SERIES[2] },
    ],
    format: (v) => String(v),
  },
  revenue: {
    label: 'Revenue',
    series: [{ key: 'wonValue', name: 'Revenue won', color: SERIES[0] }],
    format: (v, currency) => (currency ? formatAmountIn(v, currency) : v.toLocaleString()),
  },
};

const AXIS = { stroke: 'var(--color-text-muted)', fontSize: 11, tickLine: false } as const;

/** The legend, in text colours; a swatch carries each series' identity. */
export function ChartLegend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className={styles.legend}>
      {items.map((item) => (
        <span key={item.name} className={styles.legendItem}>
          <span className={styles.legendSwatch} style={{ background: item.color }} aria-hidden />
          {item.name}
        </span>
      ))}
    </div>
  );
}

function TooltipBox({ title, rows }: { title: string; rows: { name: string; color: string; value: string }[] }) {
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipTitle}>{title}</div>
      {rows.map((r) => (
        <div key={r.name} className={styles.tooltipRow}>
          <span className={styles.legendSwatch} style={{ background: r.color }} aria-hidden />
          {r.name}
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  );
}

// Day by day (week by week past two months): what the team — or one person — did.
// A single day has no trend, so Today and Yesterday show the last 7 days.
export function TrendChart({
  period,
  filters,
  views,
  currency,
  height = 240,
}: {
  period: TeamPeriodValue;
  filters: { organizationId?: string; userId?: string };
  views: TrendView[];
  currency?: string | null;
  height?: number;
}) {
  const shown = views.filter((v) => v !== 'revenue' || !!currency);
  const [view, setView] = useState<TrendView>(shown[0] ?? 'calls');
  const active = shown.includes(view) ? view : shown[0];
  const single = period.period === 'today' || period.period === 'yesterday' || (period.period === 'custom' && (!period.to || period.to === period.from));
  const effective: TeamPeriodValue = single ? { period: 'last7' } : period;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-activity-trend', effective, filters],
    queryFn: () => teamActivityService.trend(effective, filters),
    placeholderData: keepPreviousData,
  });
  const def = VIEWS[active];
  const weekly = data?.granularity === 'week';
  const rows: Row[] = (data?.points ?? []).map((p) => ({
    ...p,
    activeHours: Math.round((p.activeSeconds / 3600) * 10) / 10,
    notAnswered: p.callsMissed + p.callsUnanswered,
    tick: weekly ? `w/c ${dayjs(p.date).format('D MMM')}` : dayjs(p.date).format((data?.points.length ?? 0) <= 8 ? 'ddd D' : 'D MMM'),
  }));
  const empty = rows.every((r) => def.series.every((s) => !Number(r[s.key as keyof Row])));

  const renderTooltip = ({ active: on, payload }: TooltipProps<number, string>) => {
    const point = payload?.[0]?.payload as Row | undefined;
    if (!on || !point) return null;
    const title = weekly ? `Week of ${dayjs(point.date).format('D MMM YYYY')}` : dayjs(point.date).format('dddd D MMM YYYY');
    return <TooltipBox title={title} rows={def.series.map((s) => ({ name: s.name, color: s.color, value: def.format(Number(point[s.key as keyof Row]) || 0, currency) }))} />;
  };

  return (
    <div className={styles.chart}>
      <div className={styles.chartBar}>
        <span className={styles.chartNote}>{single ? 'Last 7 days, day by day' : weekly ? 'Week by week' : 'Day by day'}</span>
        {shown.length > 1 && (
          <div className={teamStyles.subTabs} role="tablist" aria-label="Which trend">
            {shown.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={active === v}
                className={clsx(teamStyles.subTab, active === v && teamStyles.subTabActive)}
                onClick={() => setView(v)}
              >
                {VIEWS[v].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {def.series.length > 1 && <ChartLegend items={def.series} />}
      {isLoading ? (
        <Skeleton height={height} />
      ) : isError ? (
        <EmptyState compact title="The trend couldn’t be loaded" description="Please try again in a moment." />
      ) : empty ? (
        <EmptyState
          compact
          title={`No ${def.label.toLowerCase()} in these days`}
          description={active === 'time' ? 'Time is measured while someone is using HaiVE or on a call.' : undefined}
        />
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={rows} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="tick" {...AXIS} interval="preserveStartEnd" minTickGap={8} />
            <YAxis
              {...AXIS}
              axisLine={false}
              width={active === 'revenue' ? 64 : 40}
              allowDecimals={active === 'time'}
              tickFormatter={(v: number) => (active === 'time' ? `${v}h` : active === 'revenue' ? compactNumber(v) : String(v))}
            />
            <Tooltip cursor={{ fill: 'var(--color-bg-hover)' }} content={renderTooltip} />
            {def.series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={def.series.length > 1 ? 14 : 28} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

// Measured time in HaiVE, day by day, stacked by part of the app (six named parts
// in their fixed colours, the rest as "Other"), with time on calls beside it.
export function UsageDaysChart({ days, height = 240 }: { days: TeamUsageReport['days']; height?: number }) {
  const weekly = days.length > 62;
  type Point = Record<ChartArea, number> & { date: string; tick: string; callHours: number };
  const points: Point[] = [];
  days.forEach((day, i) => {
    const point: Point =
      weekly && i % 7 !== 0
        ? points[points.length - 1]
        : (() => {
            const fresh = {
              date: day.date,
              tick: weekly ? `w/c ${dayjs(day.date).format('D MMM')}` : dayjs(day.date).format(days.length <= 8 ? 'ddd D' : 'D MMM'),
              callHours: 0,
            } as Point;
            for (const a of CHART_AREAS) fresh[a.key] = 0;
            points.push(fresh);
            return fresh;
          })();
    for (const [area, seconds] of Object.entries(day.byArea)) point[chartAreaOf(area as never)] += (seconds ?? 0) / 3600;
    point.callHours += day.callSeconds / 3600;
  });
  const used = CHART_AREAS.filter((a) => points.some((p) => p[a.key] > 0));
  const anyCalls = points.some((p) => p.callHours > 0);
  if (!used.length && !anyCalls) return <EmptyState compact title="No measured time in these days" description="Time is measured while someone is using HaiVE or on a call." />;
  const callColor = 'var(--color-text-secondary)';
  const legend = [...used.map((a) => ({ name: a.label, color: a.color })), ...(anyCalls ? [{ name: 'On calls', color: callColor }] : [])];

  const renderTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    const point = payload?.[0]?.payload as Point | undefined;
    if (!active || !point) return null;
    const rows = [
      ...used.map((a) => ({ name: a.label, color: a.color, value: formatTalkTime(Math.round(point[a.key] * 3600)) })),
      ...(anyCalls ? [{ name: 'On calls', color: callColor, value: formatTalkTime(Math.round(point.callHours * 3600)) }] : []),
    ];
    return <TooltipBox title={weekly ? `Week of ${dayjs(point.date).format('D MMM YYYY')}` : dayjs(point.date).format('dddd D MMM YYYY')} rows={rows} />;
  };

  return (
    <div className={styles.chart}>
      <ChartLegend items={legend} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="tick" {...AXIS} interval="preserveStartEnd" minTickGap={8} />
          <YAxis {...AXIS} axisLine={false} width={40} tickFormatter={(v: number) => `${Math.round(v * 10) / 10}h`} />
          <Tooltip cursor={{ fill: 'var(--color-bg-hover)' }} content={renderTooltip} />
          {used.map((a, i) => (
            <Bar
              key={a.key}
              dataKey={a.key}
              stackId="haive"
              name={a.label}
              fill={a.color}
              // A 2px surface gap between stacked parts; only the top part is rounded.
              stroke="var(--color-bg-surface)"
              strokeWidth={1}
              radius={i === used.length - 1 ? [4, 4, 0, 0] : 0}
              maxBarSize={22}
              isAnimationActive={false}
            />
          ))}
          {anyCalls && <Bar dataKey="callHours" name="On calls" fill={callColor} radius={[4, 4, 0, 0]} maxBarSize={10} isAnimationActive={false} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
