import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FiArrowLeft, FiBriefcase, FiCheckSquare, FiMail, FiPhone, FiTrendingUp } from 'react-icons/fi';
import { Avatar, Button, Skeleton, StatTile } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import { teamActivityService, type TeamActivityPerson, type TeamListKind, type TeamPeriodValue } from '@/services/teamActivityService';
import { ActivityList, ActivityListModal } from './ActivityList';
import { TeamActivityKpis } from './TeamActivityKpis';
import { TeamTrendChart } from './TeamTrendChart';
import { PeriodPicker, describePeriod } from './PeriodPicker';
import type { MetricDef } from './metrics';
import styles from './TeamActivity.module.css';

type Section = 'calls' | 'emails' | 'deals' | 'followups' | 'sales';
type DealView = 'deals_created' | 'deals_won' | 'deals_lost' | 'pipeline';

const DEAL_VIEWS: { id: DealView; label: string }[] = [
  { id: 'deals_created', label: 'Created' },
  { id: 'deals_won', label: 'Won' },
  { id: 'deals_lost', label: 'Lost' },
  { id: 'pipeline', label: 'Open pipeline' },
];
type EmailView = Extract<
  TeamListKind,
  'emails_sent' | 'emails_replied' | 'emails_not_replied' | 'emails_missed' | 'emails_received' | 'emails_customer_replies' | 'emails_awaiting_customer'
>;

const EMAIL_VIEWS: { id: EmailView; label: string }[] = [
  { id: 'emails_sent', label: 'Sent' },
  { id: 'emails_replied', label: 'Replied' },
  { id: 'emails_not_replied', label: 'Not replied' },
  { id: 'emails_missed', label: 'Missed' },
  { id: 'emails_received', label: 'Received' },
  { id: 'emails_customer_replies', label: 'Customer replies' },
  { id: 'emails_awaiting_customer', label: 'Awaiting customer' },
];

/** The current month's "YYYY-MM-DD" bounds, for the sales figures (they are counted by whole month). */
function thisMonth(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { dateFrom: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, dateTo: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(last)}` };
}

// One person: their figures for the period, and every call (with its summary,
// score and recording), email and deal behind them.
export function PersonActivityView({
  person,
  period,
  onPeriodChange,
  onBack,
  isCurrentBusiness,
}: {
  person: TeamActivityPerson;
  period: TeamPeriodValue;
  onPeriodChange: (value: TeamPeriodValue) => void;
  onBack?: () => void;
  isCurrentBusiness: boolean;
}) {
  const [section, setSection] = useState<Section>('calls');
  const [emailView, setEmailView] = useState<EmailView>('emails_sent');
  const [dealView, setDealView] = useState<DealView>('deals_created');
  const [openList, setOpenList] = useState<MetricDef | null>(null);
  const filters = { organizationId: person.businessId, userId: person.userId };

  const { data, isFetching } = useQuery({
    queryKey: ['team-activity-person', period, filters],
    queryFn: () => teamActivityService.overview(period, filters),
    placeholderData: keepPreviousData,
  });
  const counts = data?.people[0] ?? person;

  // Revenue and pipeline come from the Dashboard's own figures (this business only).
  const month = thisMonth();
  const { data: sales, isLoading: salesLoading } = useQuery({
    queryKey: ['agent-activity-user', person.userId, month.dateFrom, month.dateTo],
    queryFn: () => analyticsDashboardService.getOverview(month.dateFrom, month.dateTo, undefined, person.userId),
    enabled: isCurrentBusiness && section === 'sales',
  });
  const salesRow = sales?.employeeLeaderboard.find((r) => r.userId === person.userId);
  const breakdown = sales?.workBreakdown.find((r) => r.userId === person.userId);

  const sections: { id: Section; label: string; icon: typeof FiPhone; count?: number }[] = [
    { id: 'calls', label: 'Calls', icon: FiPhone, count: counts.calls },
    { id: 'emails', label: 'Emails', icon: FiMail, count: counts.emailsSent + counts.emailsReceived },
    { id: 'deals', label: 'Deals', icon: FiBriefcase, count: counts.dealsCreated + counts.dealsWon + counts.dealsLost },
    { id: 'followups', label: 'Follow-ups', icon: FiCheckSquare, count: counts.followUpsPending },
    ...(isCurrentBusiness ? [{ id: 'sales' as Section, label: 'Sales this month', icon: FiTrendingUp }] : []),
  ];

  return (
    <div className={styles.page}>
      <div className={styles.personHeader}>
        <div className={styles.personHeaderMain}>
          {onBack && (
            <Button type="button" variant="ghost" size="sm" leftIcon={<FiArrowLeft />} onClick={onBack}>
              Everyone
            </Button>
          )}
          <Avatar name={person.name} size="lg" />
          <div className={styles.personHeaderText}>
            <h1>{person.name}</h1>
            <span>{[person.role, person.businessName, person.email].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        <PeriodPicker value={period} onChange={onPeriodChange} id="person-period" />
      </div>

      <div className={clsx(styles.fade, isFetching && styles.fading)}>
        <TeamActivityKpis counts={counts} onOpen={setOpenList} currency={person.currency} />
      </div>

      <TeamTrendChart period={period} filters={filters} />

      <div className={styles.sectionTabs} role="tablist" aria-label="What to show">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              className={clsx(styles.sectionTab, section === s.id && styles.sectionTabActive)}
              onClick={() => setSection(s.id)}
            >
              <Icon aria-hidden /> {s.label}
              {s.count !== undefined && <span className={styles.sectionCount}>{s.count}</span>}
            </button>
          );
        })}
      </div>

      <div className={styles.sectionBody}>
        {section === 'calls' && <ActivityList kind="calls" period={period} filters={filters} showPerson={false} />}
        {section === 'emails' && (
          <>
            <div className={styles.subTabs} role="tablist" aria-label="Which emails">
              {EMAIL_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={emailView === v.id}
                  className={clsx(styles.subTab, emailView === v.id && styles.subTabActive)}
                  onClick={() => setEmailView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <ActivityList kind={emailView} period={period} filters={filters} showPerson={false} />
          </>
        )}
        {section === 'deals' && (
          <>
            <div className={styles.subTabs} role="tablist" aria-label="Which deals">
              {DEAL_VIEWS.map((v) => (
                <button key={v.id} type="button" role="tab" aria-selected={dealView === v.id} className={clsx(styles.subTab, dealView === v.id && styles.subTabActive)} onClick={() => setDealView(v.id)}>
                  {v.label}
                </button>
              ))}
            </div>
            <ActivityList kind={dealView} period={period} filters={filters} showPerson={false} />
          </>
        )}
        {section === 'followups' && <ActivityList kind="follow_ups" period={period} filters={filters} showPerson={false} />}
        {section === 'sales' &&
          (salesLoading ? (
            <Skeleton height={120} />
          ) : (
            <div className={styles.salesGrid}>
              <StatTile value={money(salesRow?.revenue ?? 0)} label="Revenue (won)" />
              <StatTile value={salesRow?.wonCount ?? 0} label="Deals won" />
              <StatTile value={money(salesRow?.pipelineValue ?? 0)} label="Open pipeline" />
              <StatTile value={breakdown?.openCount ?? 0} label="Open deals" />
              <StatTile value={breakdown?.conversionRate === null || breakdown?.conversionRate === undefined ? '—' : `${breakdown.conversionRate}%`} label="Conversion rate" />
            </div>
          ))}
      </div>

      <ActivityListModal
        kind={openList?.list ?? null}
        onClose={() => setOpenList(null)}
        period={period}
        filters={{ ...filters, callFilter: openList?.callFilter }}
        showPerson={false}
        subtitle={openList ? `${person.name} — ${openList.meaning}` : undefined}
      />
      <span className={styles.srOnly}>{describePeriod(period)}</span>
    </div>
  );
}
