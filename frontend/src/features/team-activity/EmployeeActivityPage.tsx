import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiActivity, FiAlertTriangle, FiAward, FiBarChart2, FiBriefcase, FiClock, FiGrid, FiHome, FiLifeBuoy, FiMail, FiPhone, FiTrendingUp, FiUsers, FiX } from 'react-icons/fi';
import { EmptyState, PageHeader, SectionCard, SelectMenu, Skeleton, Tabs } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { formatAmountIn } from '@/utils/currency';
import {
  formatTalkTime,
  formatWait,
  teamActivityService,
  type TeamActivityOverview,
  type TeamActivityPerson,
  type TeamPeriodValue,
  type TeamSupportItem,
} from '@/services/teamActivityService';
import { ActivityListModal } from './ActivityList';
import { TrendChart } from './ActivityCharts';
import { FreshnessLine, KpiCards, ShareBars } from './EmployeeParts';
import { headlineCards } from './headline';
import { PeriodPicker, describePeriod, describePrevious, periodFromSearch, periodToSearch } from './PeriodPicker';
import { TeamActivityKpis } from './TeamActivityKpis';
import { TeamActivityTable } from './TeamActivityTable';
import { BusinessesTable } from './TeamOverviewParts';
import { DepartmentsTable, SupportList } from './TeamSupportParts';
import { TeamUsageView } from './UsageViews';
import { activityStatus } from './status';
import { SERIES } from './usageAreas';
import type { MetricDef, MetricKey } from './metrics';
import taskStyles from './TeamTasks.module.css';
import teamStyles from './TeamActivity.module.css';
import styles from './EmployeeActivity.module.css';

type Tab = 'overview' | 'sales' | 'email' | 'calls' | 'usage';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <FiBarChart2 /> },
  { id: 'sales', label: 'Sales', icon: <FiBriefcase /> },
  { id: 'email', label: 'Email', icon: <FiMail /> },
  { id: 'calls', label: 'Calls', icon: <FiPhone /> },
  { id: 'usage', label: 'App usage', icon: <FiActivity /> },
];

const TAB_FIGURES: Record<Exclude<Tab, 'overview' | 'usage'>, MetricKey[]> = {
  sales: ['dealsCreated', 'dealsWon', 'dealsLost', 'dealConversionPct', 'wonValue', 'pipelineValue'],
  email: ['emailsSent', 'emailsReceived', 'emailsReplied', 'avgResponseSeconds', 'emailsNotReplied', 'emailsUnanswered', 'emailsMissed', 'awaitingCustomer'],
  calls: ['calls', 'callsMade', 'callsReceived', 'callConnectionRatePct', 'callsMissed', 'callsUnanswered', 'talkSeconds', 'avgCallSeconds'],
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Who did best by one figure, as bars with the numbers written out (the table below has the rest). */
function PeopleBars({
  people,
  value,
  display,
  ariaLabel,
  onOpen,
  ascending,
}: {
  people: TeamActivityPerson[];
  value: (p: TeamActivityPerson) => number | null;
  display: (p: TeamActivityPerson) => string;
  ariaLabel: string;
  onOpen: (p: TeamActivityPerson) => void;
  ascending?: boolean;
}) {
  const rows = people
    .filter((p) => (value(p) ?? 0) > 0)
    .sort((a, b) => (ascending ? (value(a) ?? 0) - (value(b) ?? 0) : (value(b) ?? 0) - (value(a) ?? 0)))
    .slice(0, 8);
  if (rows.length === 0) return <EmptyState compact title="Nothing to compare yet" description="The bars appear once someone has done this in the period." />;
  // Fastest replies get the longest bar: drawn as speed, written as the wait.
  const max = Math.max(...rows.map((p) => value(p) ?? 0));
  return (
    <ShareBars
      ariaLabel={ariaLabel}
      onSelect={(key) => {
        const person = rows.find((p) => `${p.businessId}|${p.userId}` === key);
        if (person) onOpen(person);
      }}
      rows={rows.map((p) => ({
        key: `${p.businessId}|${p.userId}`,
        label: p.name,
        value: ascending ? max - (value(p) ?? 0) + max * 0.08 : (value(p) ?? 0),
        color: SERIES[0],
        display: display(p),
      }))}
    />
  );
}

// Employee Activity (formerly Agent Activity): how the team works — sales, email,
// calls and measured working time — per employee, for any period, with each
// employee's own page. The Main Account owner sees every business (with a
// business filter); an owner or admin their team; a manager their store; anyone
// else is taken to their own page — the server decides.
export function EmployeeActivityPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const period = periodFromSearch(params);
  const business = params.get('business') ?? 'all';
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const [openList, setOpenList] = useState<MetricDef | null>(null);
  const [supportList, setSupportList] = useState<TeamSupportItem | null>(null);
  const [department, setDepartment] = useState<string | null>(null);

  const update = (next: { period?: TeamPeriodValue; business?: string; tab?: Tab }) => {
    const p = next.period ?? period;
    const b = next.business ?? business;
    const t = next.tab ?? tab;
    setParams({ ...periodToSearch(p), ...(b !== 'all' ? { business: b } : {}), ...(t !== 'overview' ? { tab: t } : {}) }, { replace: true });
  };

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['team-activity', period, business, 'compare'],
    queryFn: () => teamActivityService.overview(period, { organizationId: business, compare: true }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const businessOptions = useMemo(
    () => [{ value: 'all', label: 'All businesses' }, ...(data?.businesses ?? []).map((b) => ({ value: b.id, label: b.name, hint: b.isMain ? 'Main Account' : 'Sub-account' }))],
    [data?.businesses],
  );

  const openPerson = (userId: string, businessId: string) =>
    navigate({ pathname: ROUTES.employeeProfileOf(userId), search: new URLSearchParams({ ...periodToSearch(period), business: businessId }).toString() });

  // Someone who sees only themselves has their own page.
  if (data && !data.team && data.people[0]) {
    return (
      <Navigate
        to={{
          pathname: ROUTES.employeeProfileOf(data.people[0].userId),
          search: new URLSearchParams({ ...periodToSearch(period), business: data.people[0].businessId }).toString(),
        }}
        replace
      />
    );
  }

  const header = (
    <PageHeader
      icon={FiActivity}
      title="Employee Activity"
      subtitle="How your team works — sales, email, calls and time — for each employee. Click any number to see what’s behind it."
      meta={data ? <FreshnessLine sources={data.sources} generatedAt={data.generatedAt} /> : undefined}
      actions={
        <div className={teamStyles.headerActions}>
          {data?.acrossBusinesses && (
            <SelectMenu
              value={business}
              options={businessOptions}
              onChange={(b) => update({ business: b })}
              ariaLabel="Business"
              icon={<FiHome aria-hidden />}
              className={teamStyles.businessPicker}
            />
          )}
          <PeriodPicker value={period} onChange={(p) => update({ period: p })} />
        </div>
      }
    />
  );

  if (isLoading) {
    return (
      <div className={teamStyles.page}>
        {header}
        <div className={styles.kpiGrid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height={112} />
          ))}
        </div>
        <Skeleton height={300} />
        <Skeleton height={240} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={teamStyles.page}>
        {header}
        <EmptyState icon={FiAlertTriangle} title="Employee Activity couldn’t be loaded" description="Please try again in a moment." />
      </div>
    );
  }

  const showBusiness = data.acrossBusinesses && business === 'all';
  const against = data.previous ? describePrevious(period) : undefined;
  const staff = data.people.filter((p) => !p.mainAccountMember && p.active);
  const activeNow = staff.filter((p) => activityStatus(p.lastActiveAt).tone === 'now').length;
  const currency = data.summary.currency;
  const periodWords = describePeriod(period);
  const departmentOf = (p: TeamActivityPerson) => `${p.businessId}|${p.department ?? ''}`;
  const shownDepartment = department ? data.departments.find((d) => d.key === department) : undefined;
  const onTile = (m: MetricDef) => (m.list ? setOpenList(m) : update({ tab: 'usage' }));
  const onPerson = (p: TeamActivityPerson) => openPerson(p.userId, p.businessId);
  const trendFilters = { organizationId: business };

  return (
    <div className={teamStyles.page}>
      {header}

      <div className={styles.tabBar}>
        <div className={styles.tabScroller}>
          <Tabs items={TABS} activeId={tab} onChange={(id) => update({ tab: id as Tab })} />
        </div>
        {data.businesses.length === 1 && period.period !== 'today' && period.period !== 'yesterday' && (
          <span className={teamStyles.rangeNote}>
            {dayjs(data.businesses[0].from).format('D MMM')} – {dayjs(data.businesses[0].to).format('D MMM YYYY')}
          </span>
        )}
      </div>

      <div className={clsx(styles.tabBody, teamStyles.fade, isFetching && teamStyles.fading)}>
        {tab === 'overview' && (
          <>
            <KpiCards
              against={against}
              cards={headlineCards(data.totals, data.previous?.totals, currency, (t) => update({ tab: t }), {
                employees: data.summary.employees,
                active: data.summary.activeEmployees,
                now: activeNow,
              })}
            />

            <SectionCard title="Daily activity" icon={FiTrendingUp}>
              <TrendChart period={period} filters={trendFilters} views={['time', 'calls', 'emails', 'deals']} />
            </SectionCard>

            <UnattributedNotice overview={data} periodWords={periodWords} />

            {(data.attention.length > 0 || data.departments.length > 0) && (
              <>
                {data.attention.length > 0 && (
                  <SectionCard title={`Needs support · ${data.attention.length}`} icon={FiLifeBuoy}>
                    <SupportList
                      items={data.attention}
                      showBusiness={showBusiness}
                      onOpenPerson={(item) => openPerson(item.personId, item.businessId)}
                      onOpenList={setSupportList}
                    />
                  </SectionCard>
                )}
                {data.departments.length > 0 && (
                  <SectionCard title={`Teams ${periodWords}`} icon={FiUsers}>
                    <DepartmentsTable departments={data.departments} activeKey={department} showBusiness={showBusiness} onSelect={setDepartment} />
                  </SectionCard>
                )}
              </>
            )}

            {showBusiness && data.businesses.length > 1 && (
              <SectionCard title={`Businesses ${periodWords}`} icon={FiGrid}>
                <BusinessesTable businesses={data.businesses} onSelect={(id) => update({ business: id })} />
              </SectionCard>
            )}

            <SectionCard title={shownDepartment ? `Employees · ${shownDepartment.name}` : `Employees · ${staff.length}`} icon={FiUsers}>
              {shownDepartment && (
                <div className={taskStyles.filterNote}>
                  Showing {shownDepartment.name} only.
                  <button type="button" className={taskStyles.more} onClick={() => setDepartment(null)}>
                    <FiX aria-hidden /> Show everyone
                  </button>
                </div>
              )}
              <TeamActivityTable
                people={shownDepartment ? data.people.filter((p) => departmentOf(p) === shownDepartment.key) : data.people}
                onSelect={onPerson}
                showBusiness={showBusiness}
                filters
              />
            </SectionCard>
          </>
        )}

        {tab === 'sales' && (
          <>
            <TeamActivityKpis counts={data.totals} onOpen={onTile} currency={currency} only={TAB_FIGURES.sales} />
            <div className={styles.twoUp}>
              <SectionCard title="Deals, day by day" icon={FiTrendingUp}>
                <TrendChart period={period} filters={trendFilters} views={['deals', 'revenue']} currency={currency} />
              </SectionCard>
              <SectionCard title={currency ? 'Revenue won by employee' : 'Deals won by employee'} icon={FiAward}>
                <PeopleBars
                  people={data.people}
                  ariaLabel="Won by employee"
                  value={(p) => (currency ? p.wonValue : p.dealsWon)}
                  display={(p) => (currency ? `${formatAmountIn(p.wonValue, p.currency)} · ${p.dealsWon}` : String(p.dealsWon))}
                  onOpen={onPerson}
                />
              </SectionCard>
            </div>
            <UnattributedNotice overview={data} periodWords={periodWords} />
            <SectionCard
              title="Sales by employee"
              icon={FiUsers}
              info="Deals are credited to who created them in HaiVE, else to the deal’s owner, else to the HaiVE login its CRM salesperson is linked to in Settings → Deal Assignment."
            >
              <TeamActivityTable people={data.people} onSelect={onPerson} showBusiness={showBusiness} initialSet="sales" columnSwitch={false} />
            </SectionCard>
          </>
        )}

        {tab === 'email' && (
          <>
            <TeamActivityKpis counts={data.totals} onOpen={onTile} only={TAB_FIGURES.email} />
            <div className={styles.twoUp}>
              <SectionCard title="Email, day by day" icon={FiTrendingUp}>
                <TrendChart period={period} filters={trendFilters} views={['emails']} />
              </SectionCard>
              <SectionCard title="Fastest replies" icon={FiClock} info="Average time customers waited for a reply, per employee — replies written in HaiVE or Outlook.">
                <PeopleBars
                  people={data.people}
                  ariaLabel="Average reply time"
                  value={(p) => p.avgResponseSeconds}
                  display={(p) => formatWait(p.avgResponseSeconds)}
                  onOpen={onPerson}
                  ascending
                />
              </SectionCard>
            </div>
            <SectionCard
              title="Email by employee"
              icon={FiUsers}
              info="Sent: everything that left their mailbox. Replied: customer emails they answered. Awaiting reply: still inside 24 hours. Unanswered: still owed a reply, however old. Missed: 24 hours passed with no reply."
            >
              <TeamActivityTable people={data.people} onSelect={onPerson} showBusiness={showBusiness} initialSet="email" columnSwitch={false} />
            </SectionCard>
          </>
        )}

        {tab === 'calls' && (
          <>
            <TeamActivityKpis counts={data.totals} onOpen={onTile} only={TAB_FIGURES.calls} />
            <div className={styles.twoUp}>
              <SectionCard title="Calls, day by day" icon={FiTrendingUp}>
                <TrendChart period={period} filters={trendFilters} views={['calls']} />
              </SectionCard>
              <SectionCard title="Talk time by employee" icon={FiPhone}>
                <PeopleBars
                  people={data.people}
                  ariaLabel="Talk time"
                  value={(p) => p.talkSeconds}
                  display={(p) => `${formatTalkTime(p.talkSeconds)} · ${plural(p.calls, 'call')}`}
                  onOpen={onPerson}
                />
              </SectionCard>
            </div>
            <SectionCard
              title="Calls by employee"
              icon={FiUsers}
              info="Missed: incoming calls nobody answered. Unanswered: outgoing calls the other side didn’t pick up. Connected: of all phone calls, the share that connected."
            >
              <TeamActivityTable people={data.people} onSelect={onPerson} showBusiness={showBusiness} initialSet="calls" columnSwitch={false} />
            </SectionCard>
          </>
        )}

        {tab === 'usage' && (
          <TeamUsageView period={period} business={business} previousActiveSeconds={data.previous?.totals.activeSeconds} against={against} onOpenPerson={openPerson} />
        )}
      </div>

      <ActivityListModal
        kind={openList?.list ?? null}
        onClose={() => setOpenList(null)}
        period={period}
        filters={{ organizationId: business, callFilter: openList?.callFilter }}
        showPerson={data.team}
        subtitle={openList?.meaning}
      />
      <ActivityListModal
        kind={supportList?.list ?? null}
        onClose={() => setSupportList(null)}
        period={period}
        filters={{ organizationId: supportList?.businessId, userId: supportList?.personId, callFilter: supportList?.callFilter }}
        showPerson={false}
        subtitle={supportList ? `${supportList.personName} — ${supportList.text}` : undefined}
      />
    </div>
  );
}

/** Deals created in the CRM that nobody is credited with: who the CRM names, and where to link them. */
function UnattributedNotice({ overview, periodWords }: { overview: TeamActivityOverview; periodWords: string }) {
  const { total, byCrmOwner } = overview.unattributedDeals;
  if (total === 0) return null;
  return (
    <div className={teamStyles.notice} role="note">
      <FiAlertTriangle aria-hidden />
      <span>
        <strong>
          {plural(total, 'deal')} created {periodWords} {total === 1 ? 'isn’t' : 'aren’t'} credited to anyone
        </strong>{' '}
        — the CRM names a salesperson who isn’t linked to a login:{' '}
        {byCrmOwner
          .slice(0, 4)
          .map((o) => `${o.label}${o.shared ? ' (shared account)' : ''} ${o.count}`)
          .join(', ')}
        {byCrmOwner.length > 4 ? '…' : ''}. <Link to={ROUTES.settingsDealAssignment}>Link them in Deal Assignment</Link>
      </span>
    </div>
  );
}
