import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatINR as money } from '@/utils/currency';
import type { AnalyticsDashboardOverview } from '@/services/analyticsDashboardService';
import styles from './AgentComparisonChart.module.css';

type LeaderboardRow = AnalyticsDashboardOverview['employeeLeaderboard'][number];

// Same click-a-bar-to-select mechanism as AgentComparisonChart (the AI
// task-activity chart this page used to show) — reused here for revenue
// instead of task count. One consistent bar color (not per-agent
// avatarColor, which doesn't exist for arbitrary sales users) — same
// single-series convention TaskTrendChart already uses.
export function UserRevenueComparisonChart({
  rows,
  onSelect,
}: {
  rows: LeaderboardRow[];
  onSelect: (userId: string) => void;
}) {
  return (
    <div className={styles.wrapper}>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="userName" stroke="var(--color-text-muted)" fontSize={12} />
          <YAxis stroke="var(--color-text-muted)" fontSize={12} tickFormatter={(v: number) => money(v)} width={80} />
          <Tooltip
            cursor={{ fill: 'var(--color-bg-hover)' }}
            formatter={(value: number, name: string) => [money(value), name]}
            contentStyle={{
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
            }}
            labelStyle={{ color: 'var(--color-text-primary)' }}
          />
          <Bar
            dataKey="revenue"
            name="Revenue"
            fill="var(--brand-accent-primary)"
            radius={[4, 4, 0, 0]}
            cursor="pointer"
            onClick={(data: LeaderboardRow) => onSelect(data.userId)}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
