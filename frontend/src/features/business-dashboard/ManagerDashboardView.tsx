import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FiBarChart2, FiClipboard, FiClock, FiUsers } from 'react-icons/fi';
import { Badge, SectionCard, Skeleton, StatTile } from '@/components/ui';
import { businessDashboardService } from '@/services/businessDashboardService';
import { customerActivityService } from '@/services/customerActivityService';
import { homeDashboardService } from '@/services/homeDashboardService';
import { ROUTES } from '@/constants/routes';
import { formatINR as money } from '@/utils/currency';
import { CustomerActivitySection } from './components/CustomerActivitySection';
import { AiRecommendationsSection } from './components/AiRecommendationsSection';
import { CriticalAlertsSection } from './components/CriticalAlertsSection';
import { TodaysTasksSection } from './components/TodaysTasksSection';
import { EmailSummarySection } from './components/EmailSummarySection';
import { TimelineSection } from './components/TimelineSection';
import { HistoricalActivityFooter } from './components/HistoricalActivityFooter';
import { openDealDrawer } from '@/stores/dealDrawerStore';
import styles from './business-dashboard.module.css';

export function ManagerDashboardView() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['manager-dashboard-overview'],
    queryFn: () => businessDashboardService.getManagerOverview(),
    refetchInterval: 60_000,
    retry: false,
  });
  // Same endpoint Deal Performance's Customer Activity tab uses — the
  // backend already forces a manager's storeConstraint from their own JWT,
  // so this compact section and "View full →" always show the same store's
  // data as this dashboard itself.
  const { data: activity } = useQuery({
    queryKey: ['customer-activity-overview'],
    queryFn: () => customerActivityService.getOverview(),
    refetchInterval: 60_000,
  });
  const { data: home } = useQuery({
    queryKey: ['home-dashboard-manager'],
    queryFn: () => homeDashboardService.getManagerHome(),
    refetchInterval: 60_000,
  });

  if (isError) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>No store is assigned to this account yet.</div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <Skeleton height={100} />
        <Skeleton height={160} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div>
        <div className={styles.pageTitle}>Store Overview</div>
        <div className={styles.pageSubtitle}>{data.period}</div>
      </div>

      {/* Tier 1 */}
      {home ? <AiRecommendationsSection items={home.aiRecommendations} /> : <Skeleton height={100} />}

      {/* Tier 2 */}
      {home && <CriticalAlertsSection groups={home.criticalAlerts} />}

      {/* Tier 3 */}
      <TodaysTasksSection
        calendarEvents={data.teamCalendar.available ? data.teamCalendar.events : undefined}
        calendarMessage={data.teamCalendar.available ? undefined : data.teamCalendar.message}
      />

      {/* Tier 4 */}
      {activity && (
        <CustomerActivitySection
          data={activity}
          topItemsTitle="Staleist Unactioned Items"
          topItems={[...activity.unactionedItems]
            .sort((a, b) => b.daysSinceLastUpdate - a.daysSinceLastUpdate)
            .slice(0, 3)
            .map((item) => ({
              key: `${item.type}-${item.id}`,
              title: item.businessName,
              meta: `${item.type === 'deal' ? 'Deal' : 'Quote'}: ${item.name} — ${item.daysSinceLastUpdate}d since last update`,
            }))}
          viewFullLabel="View full Customer Activity →"
          onViewFull={() => navigate(`${ROUTES.dealPerformance}?tab=customer-activity`)}
          extraStats={[{ value: data.dealsAtRisk.length, label: 'Deals at Risk' }]}
        />
      )}

      {/* Tier 5 */}
      {home && <EmailSummarySection summary={home.emailSummary} />}

      {/* Tier 6 — Sales Performance (existing, repositioned) */}
      <SectionCard title="This Period" icon={FiBarChart2}>
        <div className={styles.statsGrid}>
          <StatTile value={money(data.storeTarget)} label="Store Target" />
          <StatTile value={data.storeAchievement === null ? '—' : `${data.storeAchievement}%`} label="Store Achievement" />
          <StatTile value={money(data.revenue)} label="Revenue" />
          <StatTile value={data.conversionRate === null ? '—' : `${data.conversionRate}%`} label="Conversion Rate" />
        </div>
      </SectionCard>

      <SectionCard
        title="Today's EOD Report"
        icon={FiClipboard}
        action={
          <Badge variant={data.missedEodReportToday ? 'warning' : 'success'} dot>
            {data.missedEodReportToday ? 'Missed' : 'Submitted'}
          </Badge>
        }
      >
        <div className={styles.emptyState}>
          {data.missedEodReportToday ? "Today's EOD report hasn't been submitted yet." : "Today's EOD report is in."}
        </div>
      </SectionCard>

      <div className={styles.twoColumn}>
        <SectionCard title="Team Performance" icon={FiUsers}>
          {data.teamPerformance.length === 0 ? (
            <div className={styles.emptyState}>No won deals recorded yet this period.</div>
          ) : (
            data.teamPerformance.map((r, i) => (
              <div key={r.userId} className={styles.rankRow}>
                <span className={styles.rankPosition}>#{i + 1}</span>
                <span className={styles.rankName}>{r.userName}</span>
                <span className={styles.rankValue}>{money(r.revenue)}</span>
              </div>
            ))
          )}
        </SectionCard>

        <SectionCard title="Follow-ups — Next 7 Days" icon={FiClock}>
          {data.followUps.length === 0 ? (
            <div className={styles.emptyState}>No deals need follow-up in the next 7 days.</div>
          ) : (
            data.followUps.map((d) => (
              <button key={d.dealId} type="button" className={`${styles.listItem} ${styles.listItemButton}`} onClick={() => openDealDrawer(d.dealId)}>
                <div className={styles.listItemMain}>
                  <span className={styles.listItemTitle}>{d.name}</span>
                  <span className={styles.listItemMeta}>Expected close: {d.expectedClosingDate}</span>
                </div>
                <span className={styles.rankValue}>{money(d.monetaryValue)}</span>
              </button>
            ))
          )}
        </SectionCard>
      </div>

      {/* Tier 7 */}
      {home && <TimelineSection events={home.timeline} />}

      {/* Tier 8 */}
      <HistoricalActivityFooter />
    </div>
  );
}
