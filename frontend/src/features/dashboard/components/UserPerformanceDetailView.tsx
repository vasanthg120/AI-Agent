import { useQuery } from '@tanstack/react-query';
import { FiArrowLeft, FiBarChart2 } from 'react-icons/fi';
import { Avatar, Button, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import styles from './AgentFocusedView.module.css';

// Drill-down for one user, reached by clicking their bar in
// UserRevenueComparisonChart — mirrors AgentFocusedView's header/back-button
// layout (the AI task-activity drill-down this page used to show), but with
// revenue/pipeline/dues/win-rate instead of task stats. Re-fetches the same
// analytics-dashboard endpoint scoped to just this one user (admin/owner
// override via userId; a self-scoped caller's own userId is a no-op server-side).
export function UserPerformanceDetailView({
  userId,
  dateFrom,
  dateTo,
  onBack,
}: {
  userId: string;
  dateFrom: string;
  dateTo: string;
  onBack?: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-activity-user', userId, dateFrom, dateTo],
    queryFn: () => analyticsDashboardService.getOverview(dateFrom, dateTo, undefined, userId),
  });

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <Skeleton height={80} />
        <Skeleton height={160} />
      </div>
    );
  }

  const leaderboardRow = data.employeeLeaderboard.find((r) => r.userId === userId) ?? data.employeeLeaderboard[0];
  const breakdownRow = data.workBreakdown.find((r) => r.userId === userId) ?? data.workBreakdown[0];
  const userName = leaderboardRow?.userName ?? breakdownRow?.userName ?? 'User';

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.agentHeader}>
          <Avatar name={userName} size="lg" />
          <div className={styles.agentName}>{userName}</div>
        </div>
        {onBack && (
          <Button type="button" variant="ghost" leftIcon={<FiArrowLeft />} onClick={onBack}>
            All Users
          </Button>
        )}
      </div>

      <SectionCard title="Performance" icon={FiBarChart2}>
        <div className={styles.statsGrid}>
          <StatTile value={money(leaderboardRow?.revenue ?? 0)} label="Revenue" />
          <StatTile value={money(leaderboardRow?.pipelineValue ?? 0)} label="Pipeline" />
          <StatTile value={money(leaderboardRow?.outstanding ?? 0)} label="Dues" />
          <StatTile value={leaderboardRow?.wonCount ?? 0} label="Deals Won" />
          <StatTile value={breakdownRow?.openCount ?? 0} label="Open Deals" />
          <StatTile
            value={breakdownRow?.conversionRate === null || breakdownRow?.conversionRate === undefined ? '—' : `${breakdownRow.conversionRate}%`}
            label="Conversion Rate"
          />
        </div>
      </SectionCard>
    </div>
  );
}
