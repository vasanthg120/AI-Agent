import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { FiBarChart2, FiClock, FiDollarSign, FiTarget, FiTrendingUp } from 'react-icons/fi';
import { Card, MonthYearFilterPopup, SectionCard, Skeleton, StatTile } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { CURRENT_MONTH, CURRENT_YEAR, rangeForMonth } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import { UserPerformanceDetailView } from './components/UserPerformanceDetailView';
import { UserRevenueComparisonChart } from './components/UserRevenueComparisonChart';
import styles from './DashboardPage.module.css';

function defaultRange(): DateRange {
  return rangeForMonth(CURRENT_YEAR, CURRENT_MONTH);
}

// Agent Activity — redesigned from an AI chat-agent task/report tracker into
// a team revenue/pipeline/dues view: every admin-created user compared on
// one chart, with a click-through to that user's own numbers. Backed by the
// same GET /analytics-dashboard/overview endpoint the Analytics Dashboard
// page uses (includeAllUsers=true here so every org user is listed, not just
// manager/consultant — see that endpoint's own comments). An admin/owner
// sees the whole org; a manager/consultant/agent_user sees only their own
// row (server-scoped, not a client-side check) — the chart and drill-down
// code paths are identical either way, just with a shorter roster.
export function DashboardPage() {
  const [range, setRange] = useState<DateRange>(defaultRange());
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const dateFrom = range.dateFrom ?? defaultRange().dateFrom!;
  const dateTo = range.dateTo ?? defaultRange().dateTo!;

  const { data, isLoading } = useQuery({
    queryKey: ['agent-activity-overview', dateFrom, dateTo],
    queryFn: () => analyticsDashboardService.getOverview(dateFrom, dateTo, undefined, undefined, true),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  if (selectedUserId) {
    return (
      <UserPerformanceDetailView
        userId={selectedUserId}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onBack={() => setSelectedUserId(null)}
      />
    );
  }

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <Skeleton height={100} />
        <Skeleton height={160} />
        <Skeleton height={280} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.pageTitle}>Agent Activity</div>
          <div className={styles.pageSubtitle}>Team revenue, pipeline, and dues across your organization</div>
        </div>
        <MonthYearFilterPopup value={range} onChange={setRange} />
      </div>

      <SectionCard title="Overview" icon={FiBarChart2}>
        <div className={styles.statsGrid}>
          <StatTile value={money(data.revenue.achieved)} label="Total Revenue" icon={FiDollarSign} />
          <StatTile value={money(data.deals.openValue)} label="Pipeline" icon={FiTrendingUp} />
          <StatTile value={money(data.outstanding.total)} label="Dues" icon={FiClock} />
          <StatTile value={data.deals.wonCount} label="Deals Won" icon={FiTarget} />
        </div>
      </SectionCard>

      <SectionCard title="Team Performance" icon={FiBarChart2}>
        {data.employeeLeaderboard.length === 0 ? (
          <div className={styles.emptyState}>No users to show yet.</div>
        ) : (
          <UserRevenueComparisonChart rows={data.employeeLeaderboard} onSelect={setSelectedUserId} />
        )}
      </SectionCard>

      <SectionCard title="All Users" icon={FiTarget}>
        {data.employeeLeaderboard.length === 0 ? (
          <div className={styles.emptyState}>No admin-created users to show yet.</div>
        ) : (
          <div className={styles.agentsGrid}>
            {data.employeeLeaderboard.map((row) => (
              <Card key={row.userId} interactive className={styles.agentCard} onClick={() => setSelectedUserId(row.userId)}>
                <div className={styles.agentCardHeader}>
                  <span className={styles.agentName}>{row.userName}</span>
                </div>
                <span className={styles.agentTaskCount}>{money(row.revenue)} revenue</span>
                <span className={styles.agentTaskCount}>{money(row.pipelineValue)} pipeline</span>
                <span className={styles.agentTaskCount}>{money(row.outstanding)} dues</span>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
