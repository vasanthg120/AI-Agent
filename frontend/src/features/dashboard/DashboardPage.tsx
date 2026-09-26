import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiActivity,
  FiArrowRight,
  FiAward,
  FiBarChart2,
  FiClock,
  FiDollarSign,
  FiSearch,
  FiTarget,
  FiTrendingUp,
  FiUsers,
} from 'react-icons/fi';
import { Avatar, EmptyState, MonthYearFilterPopup, PageHeader, SectionCard, Skeleton, StatTile } from '@/components/ui';
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

type SortKey = 'revenue' | 'pipelineValue' | 'outstanding';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'pipelineValue', label: 'Pipeline' },
  { id: 'outstanding', label: 'Dues' },
];

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
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('revenue');
  const dateFrom = range.dateFrom ?? defaultRange().dateFrom!;
  const dateTo = range.dateTo ?? defaultRange().dateTo!;

  const { data, isLoading } = useQuery({
    queryKey: ['agent-activity-overview', dateFrom, dateTo],
    queryFn: () => analyticsDashboardService.getOverview(dateFrom, dateTo, undefined, undefined, true),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const people = useMemo(() => {
    const rows = data?.employeeLeaderboard ?? [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => !q || r.userName.toLowerCase().includes(q)).sort((a, b) => b[sortBy] - a[sortBy]);
  }, [data, query, sortBy]);
  // Revenue rank is fixed regardless of the chosen sort, so medals don't move around.
  const revenueRank = useMemo(() => {
    const ranked = [...(data?.employeeLeaderboard ?? [])].sort((a, b) => b.revenue - a.revenue);
    return new Map(ranked.map((r, i) => [r.userId, i]));
  }, [data]);
  const topValue = Math.max(1, ...people.map((p) => p[sortBy]));

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

  const header = (
    <PageHeader
      icon={FiActivity}
      title="Agent Activity"
      subtitle="Team revenue, pipeline and dues across your organization. Click anyone to see their numbers in detail."
      actions={<MonthYearFilterPopup value={range} onChange={setRange} />}
    />
  );

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        {header}
        <div className={styles.statsGrid}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={104} />
          ))}
        </div>
        <Skeleton height={280} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {header}

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
          <EmptyState icon={FiUsers} title="No users to show yet" description="Add people under Settings → Users." />
        ) : (
          <UserRevenueComparisonChart rows={data.employeeLeaderboard} onSelect={setSelectedUserId} />
        )}
      </SectionCard>

      <SectionCard title="All Users" icon={FiUsers}>
        {data.employeeLeaderboard.length === 0 ? (
          <EmptyState icon={FiUsers} title="No admin-created users to show yet" />
        ) : (
          <>
            <div className={styles.peopleToolbar}>
              <label className={styles.peopleSearch}>
                <FiSearch aria-hidden />
                <input value={query} placeholder="Search people" onChange={(e) => setQuery(e.target.value)} />
              </label>
              <LayoutGroup id="agent-sort">
                <div className={styles.segmented} role="radiogroup" aria-label="Sort people by">
                  <span className={styles.segmentedLabel}>Sort by</span>
                  {SORTS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={sortBy === s.id}
                      className={clsx(styles.segment, sortBy === s.id && styles.segmentActive)}
                      onClick={() => setSortBy(s.id)}
                    >
                      {sortBy === s.id && (
                        <motion.span
                          layoutId="agent-sort-thumb"
                          className={styles.segmentThumb}
                          transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                        />
                      )}
                      <span className={styles.segmentText}>{s.label}</span>
                    </button>
                  ))}
                </div>
              </LayoutGroup>
            </div>

            {people.length === 0 ? (
              <EmptyState compact icon={FiSearch} title="Nobody matches that search" />
            ) : (
              <motion.div className={styles.agentsGrid}>
                <AnimatePresence initial={false}>
                  {people.map((row, i) => {
                    const rank = revenueRank.get(row.userId) ?? 99;
                    return (
                      <motion.button
                        key={row.userId}
                        type="button"
                        className={styles.personCard}
                        onClick={() => setSelectedUserId(row.userId)}
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 12) * 0.03 }}
                      >
                        <div className={styles.personTop}>
                          <Avatar name={row.userName} size="md" />
                          <div className={styles.personName}>
                            <span className={styles.agentName}>{row.userName}</span>
                            <span className={styles.personSub}>
                              {row.wonCount} deal{row.wonCount === 1 ? '' : 's'} won
                            </span>
                          </div>
                          {rank < 3 && row.revenue > 0 && (
                            <span className={clsx(styles.medal, styles[`medal${rank + 1}`])} title={`#${rank + 1} by revenue`}>
                              <FiAward />
                            </span>
                          )}
                        </div>

                        <div className={styles.personFigure}>
                          <span className={styles.personFigureValue}>{money(row[sortBy])}</span>
                          <span className={styles.personFigureLabel}>{SORTS.find((s) => s.id === sortBy)?.label}</span>
                        </div>
                        <div className={styles.personTrack}>
                          <motion.div
                            className={styles.personFill}
                            initial={{ width: 0 }}
                            animate={{ width: `${(row[sortBy] / topValue) * 100}%` }}
                            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                          />
                        </div>

                        <div className={styles.personStats}>
                          <span>
                            Revenue <strong>{money(row.revenue)}</strong>
                          </span>
                          <span>
                            Pipeline <strong>{money(row.pipelineValue)}</strong>
                          </span>
                          <span>
                            Dues <strong>{money(row.outstanding)}</strong>
                          </span>
                        </div>

                        <span className={styles.personCta}>
                          View details <FiArrowRight />
                        </span>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            )}
          </>
        )}
      </SectionCard>
    </div>
  );
}
