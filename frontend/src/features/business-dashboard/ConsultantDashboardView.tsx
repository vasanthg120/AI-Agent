import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FiBarChart2, FiClock, FiTarget } from 'react-icons/fi';
import { SectionCard, Skeleton, StatTile } from '@/components/ui';
import { businessDashboardService } from '@/services/businessDashboardService';
import { customerActivityService } from '@/services/customerActivityService';
import { homeDashboardService } from '@/services/homeDashboardService';
import { ROUTES } from '@/constants/routes';
import { formatINR as money } from '@/utils/currency';
import { formatStageLabel } from '@/utils/stageLabel';
import { CustomerActivitySection } from './components/CustomerActivitySection';
import { AiRecommendationsSection } from './components/AiRecommendationsSection';
import { CriticalAlertsSection } from './components/CriticalAlertsSection';
import { TodaysTasksSection } from './components/TodaysTasksSection';
import { EmailSummarySection } from './components/EmailSummarySection';
import { TimelineSection } from './components/TimelineSection';
import { HistoricalActivityFooter } from './components/HistoricalActivityFooter';
import { openDealDrawer } from '@/stores/dealDrawerStore';
import styles from './business-dashboard.module.css';

export function ConsultantDashboardView() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['consultant-dashboard-overview'],
    queryFn: () => businessDashboardService.getConsultantOverview(),
    refetchInterval: 60_000,
  });
  const { data: activity } = useQuery({
    queryKey: ['customer-activity-personal-overview'],
    queryFn: () => customerActivityService.getPersonalOverview(),
    refetchInterval: 60_000,
  });
  const { data: home } = useQuery({
    queryKey: ['home-dashboard-consultant'],
    queryFn: () => homeDashboardService.getConsultantHome(),
    refetchInterval: 60_000,
  });

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
        <div className={styles.pageTitle}>My Dashboard</div>
        <div className={styles.pageSubtitle}>{data.period}</div>
      </div>

      {/* Tier 1 */}
      {home ? <AiRecommendationsSection items={home.aiRecommendations} /> : <Skeleton height={100} />}

      {/* Tier 2 */}
      {home && <CriticalAlertsSection groups={home.criticalAlerts} />}

      {/* Tier 3 */}
      <TodaysTasksSection
        calendarEvents={data.todaysMeetings.available ? data.todaysMeetings.events : undefined}
        calendarMessage={data.todaysMeetings.available ? undefined : data.todaysMeetings.message}
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
          onViewFull={() => navigate(ROUTES.myCustomerActivity)}
          extraStats={[{ value: data.dealsAtRisk.length, label: 'Deals at Risk' }]}
        />
      )}

      {/* Tier 5 */}
      {home && <EmailSummarySection summary={home.emailSummary} />}

      {/* Tier 6 — Sales Performance (existing, repositioned) */}
      <SectionCard title="This Period" icon={FiBarChart2}>
        <div className={styles.statsGrid}>
          <StatTile value={money(data.personalTarget)} label="Personal Target" />
          <StatTile value={money(data.currentSales)} label="Current Sales" />
          <StatTile value={data.achievementPct === null ? '—' : `${data.achievementPct}%`} label="Achievement" />
          <StatTile value={money(data.remainingTarget)} label="Remaining Target" />
        </div>
      </SectionCard>

      <SectionCard title="Follow-ups — Next 7 Days" icon={FiClock}>
        {data.followUps.length === 0 ? (
          <div className={styles.emptyState}>No deals need follow-up in the next 7 days.</div>
        ) : (
          data.followUps.map((d) => (
            <div key={d.dealId} className={styles.listItem}>
              <div className={styles.listItemMain}>
                <span className={styles.listItemTitle}>{d.name}</span>
                <span className={styles.listItemMeta}>Expected close: {d.expectedClosingDate}</span>
              </div>
            </div>
          ))
        )}
      </SectionCard>

      <SectionCard title="Customer Pipeline" icon={FiTarget}>
        {data.customerPipeline.length === 0 ? (
          <div className={styles.emptyState}>Your pipeline is empty.</div>
        ) : (
          data.customerPipeline.map((d) => (
            <button key={d.dealId} type="button" className={`${styles.listItem} ${styles.listItemButton}`} onClick={() => openDealDrawer(d.dealId)}>
              <div className={styles.listItemMain}>
                <span className={styles.listItemTitle}>{d.name}</span>
                <span className={styles.listItemMeta}>Stage: {d.stageId ? formatStageLabel(d.stageId) : '—'}</span>
              </div>
              <span className={styles.rankValue}>{money(d.monetaryValue)}</span>
            </button>
          ))
        )}
      </SectionCard>

      {/* Tier 7 */}
      {home && <TimelineSection events={home.timeline} />}

      {/* Tier 8 */}
      <HistoricalActivityFooter />
    </div>
  );
}
