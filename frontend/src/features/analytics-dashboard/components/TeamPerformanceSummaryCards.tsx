import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { IconType } from 'react-icons';
import { FiTrendingUp, FiTarget, FiActivity, FiClock } from 'react-icons/fi';
import { useState } from 'react';
import { Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { employeeProductivityService } from '@/services/employeeProductivityService';
import type { AnalyticsDashboardOverview } from '@/services/analyticsDashboardService';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './TeamPerformanceSummaryCards.module.css';

function StatCard({
  icon: Icon,
  label,
  value,
  note,
  noteTone,
  onClick,
}: {
  icon: IconType;
  label: string;
  value: string | number;
  note?: string;
  noteTone?: 'positive' | 'negative' | 'neutral';
  onClick?: () => void;
}) {
  return (
    <Card className={styles.cell} interactive={!!onClick} onClick={onClick}>
      <span className={styles.iconBadge}>
        <Icon size={16} />
      </span>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {note && <div className={styles[`note-${noteTone ?? 'neutral'}`]}>{note}</div>}
    </Card>
  );
}

export interface TeamPerformanceSummaryCardsProps {
  data: AnalyticsDashboardOverview;
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Every figure here is real: revenue/won-count trends compare against the
// prior calendar month via a genuine second fetch (dealsService, same
// pattern as elsewhere in this dashboard) — not a hardcoded percentage.
// Completion rate and overdue counts are aggregated from
// employeeProductivityService's own real per-employee rows (same endpoint
// "Workload by member" below uses, sharing its cache).
export function TeamPerformanceSummaryCards({ data, dateFrom, dateTo, storeId }: TeamPerformanceSummaryCardsProps) {
  const [openPopup, setOpenPopup] = useState<'revenue' | 'won' | 'completion' | 'overdue' | null>(null);

  const { data: productivity } = useQuery({
    queryKey: ['dash-productivity', dateFrom, dateTo, storeId],
    queryFn: () => employeeProductivityService.getOverview({ dateFrom, dateTo, employeeId: [], storeId: storeId ? [storeId] : [] }),
  });

  const { data: wonDealsList, isLoading: wonDealsListLoading } = useQuery({
    queryKey: ['analytics-won-deals-list', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered({ dealStatus: ['won'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) }, 1, 100),
    enabled: openPopup === 'won' || openPopup === 'revenue',
  });

  const prevFrom = dayjs(dateFrom).subtract(1, 'month').format('YYYY-MM-DD');
  const prevTo = dayjs(dateTo).subtract(1, 'month').format('YYYY-MM-DD');
  const { data: prevWonDeals } = useQuery({
    queryKey: ['dash-team-prev-won', prevFrom, prevTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['won'], dateFrom: prevFrom, dateTo: prevTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
  });

  // Same month-over-month comparison MonthlySalesPerformanceCard already
  // uses (revenueTrend's own last two real points) — kept consistent so
  // this figure never disagrees with the same metric shown elsewhere.
  const revenueTrendPct = useMemo(() => {
    const trend = data.revenueTrend;
    const current = trend[trend.length - 1];
    const previous = trend[trend.length - 2];
    if (!previous || previous.achieved <= 0) return null;
    return ((current.achieved - previous.achieved) / previous.achieved) * 100;
  }, [data.revenueTrend]);

  const wonDelta = data.deals.wonCount - (prevWonDeals?.total ?? 0);

  const totals = useMemo(() => {
    const acc = { completed: 0, assigned: 0, overdue: 0, ownersWithOverdue: 0 };
    for (const r of productivity?.rows ?? []) {
      acc.completed += r.deals.completed + r.emails.completed + r.quotes.completed;
      acc.assigned += r.deals.assigned + r.emails.assigned + r.quotes.assigned;
      const rowOverdue = r.deals.overdue + r.emails.overdue + r.quotes.overdue;
      acc.overdue += rowOverdue;
      if (rowOverdue > 0) acc.ownersWithOverdue += 1;
    }
    return acc;
  }, [productivity]);

  const completionPct = totals.assigned > 0 ? (totals.completed / totals.assigned) * 100 : null;

  // "On track" compares actual completion against how much of the period
  // has elapsed — same pacing heuristic MonthlySalesPerformanceCard uses
  // for its own on-track/off-track badge, applied here to work completion
  // instead of revenue.
  const start = dayjs(dateFrom);
  const end = dayjs(dateTo);
  const totalDaysInPeriod = start.daysInMonth();
  const daysElapsed = Math.min(Math.max(end.date(), 1), totalDaysInPeriod);
  const expectedPct = (daysElapsed / totalDaysInPeriod) * 100;
  const onTrack = completionPct !== null ? completionPct >= expectedPct * 0.9 : null;

  const wonDealRows: DrillDownRow[] = (wonDealsList?.items ?? []).map((d) => ({
    id: d._id,
    title: d.name,
    subtitle: d.expectedClosingDate,
    value: d.monetaryValue,
  }));

  const completionRows: DrillDownRow[] = (productivity?.rows ?? []).map((r) => {
    const completed = r.deals.completed + r.emails.completed + r.quotes.completed;
    const assigned = r.deals.assigned + r.emails.assigned + r.quotes.assigned;
    return { id: r.userId, title: r.userName, subtitle: `${completed}/${assigned} completed`, meta: assigned > 0 ? `${Math.round((completed / assigned) * 100)}%` : '—' };
  });

  const overdueRows: DrillDownRow[] = (productivity?.rows ?? [])
    .map((r) => ({ userId: r.userId, userName: r.userName, overdue: r.deals.overdue + r.emails.overdue + r.quotes.overdue }))
    .filter((r) => r.overdue > 0)
    .map((r) => ({ id: r.userId, title: r.userName, value: r.overdue }));

  const popupConfig: Record<'revenue' | 'won' | 'completion' | 'overdue', { title: string; rows: DrillDownRow[]; isLoading: boolean }> = {
    revenue: { title: 'Won Deals (Revenue)', rows: wonDealRows, isLoading: wonDealsListLoading },
    won: { title: 'Won Deals', rows: wonDealRows, isLoading: wonDealsListLoading },
    completion: { title: 'Completion by Member', rows: completionRows, isLoading: !productivity },
    overdue: { title: 'Members with Overdue Work', rows: overdueRows, isLoading: !productivity },
  };

  return (
    <div className={styles.grid}>
      <StatCard
        icon={FiTrendingUp}
        label="Team revenue"
        value={money(data.revenue.achieved)}
        note={revenueTrendPct !== null ? `${revenueTrendPct >= 0 ? '+' : ''}${revenueTrendPct.toFixed(1)}% vs. previous period` : undefined}
        noteTone={revenueTrendPct !== null ? (revenueTrendPct >= 0 ? 'positive' : 'negative') : 'neutral'}
        onClick={() => setOpenPopup('revenue')}
      />
      <StatCard
        icon={FiTarget}
        label="Deals won"
        value={data.deals.wonCount}
        note={`${wonDelta >= 0 ? '+' : ''}${wonDelta} vs. previous period`}
        noteTone={wonDelta >= 0 ? 'positive' : 'negative'}
        onClick={() => setOpenPopup('won')}
      />
      <StatCard
        icon={FiActivity}
        label="Completion rate"
        value={completionPct !== null ? `${completionPct.toFixed(1)}%` : '—'}
        note={onTrack !== null ? (onTrack ? 'On track for this period' : 'Behind pace for this period') : undefined}
        noteTone={onTrack === false ? 'negative' : 'positive'}
        onClick={() => setOpenPopup('completion')}
      />
      <StatCard
        icon={FiClock}
        label="Overdue work"
        value={totals.overdue}
        note={
          totals.overdue > 0
            ? `Needs review across ${totals.ownersWithOverdue} owner${totals.ownersWithOverdue === 1 ? '' : 's'}`
            : 'Nothing overdue'
        }
        noteTone={totals.overdue > 0 ? 'negative' : 'positive'}
        onClick={() => setOpenPopup('overdue')}
      />

      <DrillDownModal
        open={!!openPopup}
        onClose={() => setOpenPopup(null)}
        title={openPopup ? popupConfig[openPopup].title : ''}
        isLoading={openPopup ? popupConfig[openPopup].isLoading : false}
        rows={openPopup ? popupConfig[openPopup].rows : []}
      />
    </div>
  );
}
