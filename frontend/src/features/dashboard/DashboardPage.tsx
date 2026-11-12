import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiActivity, FiAlertTriangle, FiBarChart2, FiGrid, FiHome, FiTrendingUp, FiUsers } from 'react-icons/fi';
import { EmptyState, PageHeader, SectionCard, SelectMenu, Skeleton } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import { teamActivityService, type TeamActivityPerson, type TeamPeriodValue } from '@/services/teamActivityService';
import { ActivityListModal } from '@/features/team-activity/ActivityList';
import { PersonActivityView } from '@/features/team-activity/PersonActivityView';
import { PeriodPicker, describePeriod } from '@/features/team-activity/PeriodPicker';
import { TeamActivityKpis } from '@/features/team-activity/TeamActivityKpis';
import { TeamActivityTable } from '@/features/team-activity/TeamActivityTable';
import { TeamTrendChart } from '@/features/team-activity/TeamTrendChart';
import { TeamSummaryStrip, BusinessesTable } from '@/features/team-activity/TeamOverviewParts';
import type { AgentActivityLinkState } from '@/features/team-activity/TeamActivityPanel';
import type { MetricDef } from '@/features/team-activity/metrics';
import teamStyles from '@/features/team-activity/TeamActivity.module.css';
import { UserRevenueComparisonChart } from './components/UserRevenueComparisonChart';

/** The current month, for the sales chart (revenue is counted by whole month). */
function thisMonth(): { dateFrom: string; dateTo: string } {
  return { dateFrom: dayjs().startOf('month').format('YYYY-MM-DD'), dateTo: dayjs().endOf('month').format('YYYY-MM-DD') };
}

// Agent Activity: what everyone did in a period — deals created, emails sent,
// replied, not replied and missed, calls and talk time, and how the AI Coach
// scored their calls — each number opening the calls, emails or deals behind
// it, and each person opening their own page. The Main Account owner sees
// every business (with a business filter); an owner or admin their team; a
// manager their store; anyone else themselves — the server decides.
export function DashboardPage() {
  // Opened from the Dashboard's Team Performance: on that person, for that period.
  const linked = (useLocation().state ?? {}) as AgentActivityLinkState;
  const [period, setPeriod] = useState<TeamPeriodValue>(linked.period ?? { period: 'today' });
  const [business, setBusiness] = useState('all');
  const [selected, setSelected] = useState<TeamActivityPerson | null>(linked.person ?? null);
  const [openList, setOpenList] = useState<MetricDef | null>(null);

  const { data, isLoading, isError, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['team-activity', period, business],
    queryFn: () => teamActivityService.overview(period, { organizationId: business }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const current = data?.businesses.find((b) => b.isCurrent);
  const showBusiness = !!data?.acrossBusinesses && business === 'all';
  const month = thisMonth();
  const salesForCurrent = !!data?.team && (business === 'all' || business === current?.id);
  const { data: sales } = useQuery({
    queryKey: ['agent-activity-overview', month.dateFrom, month.dateTo],
    queryFn: () => analyticsDashboardService.getOverview(month.dateFrom, month.dateTo, undefined, undefined, true),
    enabled: salesForCurrent,
    staleTime: 60_000,
  });

  const businessOptions = useMemo(
    () => [{ value: 'all', label: 'All businesses' }, ...(data?.businesses ?? []).map((b) => ({ value: b.id, label: b.name, hint: b.isMain ? 'Main Account' : 'Sub-account' }))],
    [data?.businesses],
  );

  if (selected) {
    return (
      <PersonActivityView
        person={selected}
        period={period}
        onPeriodChange={setPeriod}
        onBack={data?.team ? () => setSelected(null) : undefined}
        isCurrentBusiness={selected.businessId === current?.id}
      />
    );
  }

  const header = (
    <PageHeader
      icon={FiActivity}
      title="Agent Activity"
      subtitle={
        data && !data.team
          ? 'Your own deals, emails and calls — and how your calls scored.'
          : 'What everyone did — deals, emails and calls — and how their calls scored. Click any number to see what’s behind it.'
      }
      meta={dataUpdatedAt ? <span className={teamStyles.updated}>Updated {dayjs(dataUpdatedAt).format('h:mm a')} · refreshes every minute</span> : undefined}
      actions={
        <div className={teamStyles.headerActions}>
          {data?.acrossBusinesses && (
            <SelectMenu value={business} options={businessOptions} onChange={setBusiness} ariaLabel="Business" icon={<FiHome aria-hidden />} className={teamStyles.businessPicker} />
          )}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      }
    />
  );

  if (isLoading) {
    return (
      <div className={teamStyles.page}>
        {header}
        <div className={teamStyles.kpis}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height={104} />
          ))}
        </div>
        <Skeleton height={320} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={teamStyles.page}>
        {header}
        <EmptyState icon={FiAlertTriangle} title="Agent Activity couldn’t be loaded" description="Please try again in a moment." />
      </div>
    );
  }

  const periodWords = describePeriod(period);
  const rangeNote =
    data.businesses.length === 1 && period.period !== 'today' && period.period !== 'yesterday'
      ? `${dayjs(data.businesses[0].from).format('D MMM')} – ${dayjs(data.businesses[0].to).format('D MMM YYYY')}`
      : undefined;

  return (
    <div className={teamStyles.page}>
      {header}

      <div className={clsx(teamStyles.fade, isFetching && teamStyles.fading)}>
        <SectionCard
          title={data.team ? `Team ${periodWords}` : `You ${periodWords}`}
          icon={FiBarChart2}
          action={rangeNote ? <span className={teamStyles.rangeNote}>{rangeNote}</span> : undefined}
        >
          <div className={teamStyles.panel}>
            {data.team && <TeamSummaryStrip overview={data} />}
            <TeamActivityKpis counts={data.totals} onOpen={setOpenList} currency={data.summary.currency} />
          </div>
        </SectionCard>
      </div>

      {showBusiness && data.businesses.length > 1 && (
        <SectionCard title={`Businesses ${periodWords}`} icon={FiGrid}>
          <BusinessesTable businesses={data.businesses} onSelect={setBusiness} />
        </SectionCard>
      )}

      <SectionCard title="Activity trend" icon={FiTrendingUp}>
        <TeamTrendChart period={period} filters={{ organizationId: business }} />
      </SectionCard>

      {data.unattributedDeals.total > 0 && (
        <div className={teamStyles.notice} role="note">
          <FiAlertTriangle aria-hidden />
          <span>
            <strong>
              {data.unattributedDeals.total} deal{data.unattributedDeals.total === 1 ? '' : 's'} created {periodWords} {data.unattributedDeals.total === 1 ? 'isn’t' : 'aren’t'} credited to
              anyone
            </strong>{' '}
            — the CRM names a salesperson who isn’t linked to a login:{' '}
            {data.unattributedDeals.byCrmOwner
              .slice(0, 4)
              .map((o) => `${o.label}${o.shared ? ' (shared account)' : ''} ${o.count}`)
              .join(', ')}
            {data.unattributedDeals.byCrmOwner.length > 4 ? '…' : ''}. <Link to={ROUTES.settingsDealAssignment}>Link them in Deal Assignment</Link>
          </span>
        </div>
      )}

      {data.team && (
        <SectionCard title="People" icon={FiUsers}>
          <TeamActivityTable people={data.people} onSelect={setSelected} showBusiness={showBusiness} />
        </SectionCard>
      )}

      {!data.team && data.people[0] && (
        <SectionCard title="Your calls, emails and deals" icon={FiUsers}>
          <TeamActivityTable people={data.people} onSelect={setSelected} showBusiness={false} searchable={false} />
        </SectionCard>
      )}

      {salesForCurrent && sales && sales.employeeLeaderboard.length > 0 && (
        <SectionCard title={`Revenue by person · ${dayjs().format('MMMM')}${showBusiness && current ? ` · ${current.name}` : ''}`} icon={FiTrendingUp}>
          <UserRevenueComparisonChart
            rows={sales.employeeLeaderboard}
            onSelect={(userId) => {
              const person = data.people.find((p) => p.userId === userId && p.businessId === current?.id);
              if (person) setSelected(person);
            }}
          />
        </SectionCard>
      )}

      <ActivityListModal
        kind={openList?.list ?? null}
        onClose={() => setOpenList(null)}
        period={period}
        filters={{ organizationId: business, callFilter: openList?.callFilter }}
        showPerson={data.team}
        subtitle={openList?.meaning}
      />
    </div>
  );
}
