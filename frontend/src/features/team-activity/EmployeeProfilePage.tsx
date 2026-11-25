import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiActivity, FiAlertTriangle, FiArrowLeft, FiBarChart2, FiBriefcase, FiCalendar, FiCheckSquare, FiLogIn, FiMail, FiPhone, FiPlus, FiTrendingUp } from 'react-icons/fi';
import { Avatar, Badge, Button, EmptyState, SectionCard, Skeleton, Tabs } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuthStore } from '@/stores/authStore';
import { formatTalkTime, teamActivityService, type CallFilter, type TeamListKind, type TeamPeriodValue } from '@/services/teamActivityService';
import { ActivityList, ActivityListModal } from './ActivityList';
import { TrendChart } from './ActivityCharts';
import { FreshnessLine, KpiCards, StatusLabel } from './EmployeeParts';
import { GiveTaskModal } from './GiveTaskModal';
import { headlineCards } from './headline';
import { PeriodPicker, describePrevious, periodFromSearch, periodToSearch } from './PeriodPicker';
import { TeamActivityKpis } from './TeamActivityKpis';
import { PersonUsageView } from './UsageViews';
import { activityStatus } from './status';
import type { MetricDef, MetricKey } from './metrics';
import teamStyles from './TeamActivity.module.css';
import styles from './EmployeeActivity.module.css';

type Tab = 'overview' | 'sales' | 'email' | 'calls' | 'usage' | 'tasks';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <FiBarChart2 /> },
  { id: 'sales', label: 'Sales', icon: <FiBriefcase /> },
  { id: 'email', label: 'Email', icon: <FiMail /> },
  { id: 'calls', label: 'Calls', icon: <FiPhone /> },
  { id: 'usage', label: 'App usage', icon: <FiActivity /> },
  { id: 'tasks', label: 'Tasks', icon: <FiCheckSquare /> },
];

const FIGURES: Record<'sales' | 'email' | 'calls', MetricKey[]> = {
  sales: ['dealsCreated', 'dealsWon', 'dealsLost', 'dealConversionPct', 'wonValue', 'pipelineValue'],
  email: ['emailsSent', 'emailsReceived', 'emailsReplied', 'avgResponseSeconds', 'emailsNotReplied', 'emailsUnanswered', 'emailsMissed', 'awaitingCustomer'],
  calls: ['calls', 'callsMade', 'callsReceived', 'callConnectionRatePct', 'callsMissed', 'callsUnanswered', 'talkSeconds', 'avgCallScore'],
};

const DEAL_VIEWS: { id: TeamListKind; label: string }[] = [
  { id: 'deals_created', label: 'Created' },
  { id: 'deals_won', label: 'Won' },
  { id: 'deals_lost', label: 'Lost' },
  { id: 'pipeline', label: 'Open pipeline' },
];

const EMAIL_VIEWS: { id: TeamListKind; label: string }[] = [
  { id: 'emails_sent', label: 'Sent' },
  { id: 'emails_received', label: 'Received' },
  { id: 'emails_replied', label: 'Replied' },
  { id: 'emails_not_replied', label: 'Awaiting reply' },
  { id: 'emails_unanswered', label: 'Unanswered' },
  { id: 'emails_missed', label: 'Missed' },
  { id: 'emails_customer_replies', label: 'Customer replies' },
  { id: 'emails_awaiting_customer', label: 'Awaiting customer' },
];

const CALL_VIEWS: { id: CallFilter | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'made', label: 'Outgoing' },
  { id: 'received', label: 'Incoming' },
  { id: 'missed', label: 'Missed' },
  { id: 'unanswered', label: 'Unanswered' },
  { id: 'scored', label: 'Scored' },
];

function SubTabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className={teamStyles.subTabs} role="tablist" aria-label={label}>
      {items.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={value === v.id}
          className={clsx(teamStyles.subTab, value === v.id && teamStyles.subTabActive)}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// One employee's page: their sales, email and calls with every record behind
// them, their measured working time (sessions, first and last activity, where it
// went, sign-ins) and their tasks — for any period, compared with the one before.
// Who may open it is the server's decision (TeamScopeService): someone outside
// the caller's view comes back as nobody.
export function EmployeeProfilePage() {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const period = periodFromSearch(params);
  const business = params.get('business') ?? undefined;
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const [dealView, setDealView] = useState<TeamListKind>('deals_created');
  const [emailView, setEmailView] = useState<TeamListKind>('emails_sent');
  const [callView, setCallView] = useState<CallFilter | 'all'>('all');
  const [openList, setOpenList] = useState<MetricDef | null>(null);
  const [giving, setGiving] = useState(false);

  const update = (next: { period?: TeamPeriodValue; tab?: Tab }) => {
    const p = next.period ?? period;
    const t = next.tab ?? tab;
    setParams({ ...periodToSearch(p), ...(business ? { business } : {}), ...(t !== 'overview' ? { tab: t } : {}) }, { replace: true });
  };
  const filters = { organizationId: business, userId };

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['team-activity-person', period, filters, 'compare'],
    queryFn: () => teamActivityService.overview(period, { ...filters, compare: true }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const usage = useQuery({
    queryKey: ['team-activity-usage', period, filters],
    queryFn: () => teamActivityService.usage(period, filters),
    enabled: tab === 'usage' || tab === 'overview',
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const person = data?.people.find((p) => p.userId === userId);
  const backTo = { pathname: ROUTES.employeeActivity, search: new URLSearchParams(periodToSearch(period)).toString() };

  if (isLoading) {
    return (
      <div className={teamStyles.page}>
        <Skeleton height={72} />
        <div className={styles.kpiGrid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height={112} />
          ))}
        </div>
        <Skeleton height={300} />
      </div>
    );
  }
  if (isError || !data || !person) {
    return (
      <div className={teamStyles.page}>
        <EmptyState
          icon={FiAlertTriangle}
          title={isError ? 'This page couldn’t be loaded' : 'This employee isn’t in your view'}
          description={isError ? 'Please try again in a moment.' : 'They may belong to another business, or your access shows only your own work.'}
          action={
            <Button type="button" variant="ghost" leftIcon={<FiArrowLeft />} onClick={() => navigate(backTo)}>
              Employee Activity
            </Button>
          }
        />
      </div>
    );
  }

  const status = activityStatus(person.lastActiveAt);
  const team = data.team;
  const self = person.userId === me?.id;
  const canGive = team && person.active && !person.mainAccountMember && !self;
  const against = data.previous ? describePrevious(period) : undefined;
  const onTile = (m: MetricDef) => (m.list ? setOpenList(m) : update({ tab: 'usage' }));
  const listFilters = { organizationId: person.businessId, userId: person.userId };
  const recentDays = [...(usage.data?.person?.days ?? [])].reverse().slice(0, 5);
  const signIns = usage.data?.person?.signIns ?? [];

  return (
    <div className={teamStyles.page}>
      <div className={styles.profileHeader}>
        <div className={styles.profileMain}>
          <Avatar name={person.name} size="lg" status={status.tone === 'now' ? 'online' : undefined} />
          <div className={styles.profileText}>
            {team && (
              <Link to={backTo} className={styles.backLink}>
                <FiArrowLeft aria-hidden /> All employees
              </Link>
            )}
            <h1>{person.name}</h1>
            <span className={styles.profileSub}>
              {[person.role, person.businessName, person.department, person.email].filter(Boolean).map((part) => (
                <span key={part}>{part}</span>
              ))}
            </span>
            <span className={styles.profileSub}>
              <StatusLabel lastActiveAt={person.lastActiveAt} />
              {!person.active && <Badge variant="neutral">Deactivated</Badge>}
            </span>
          </div>
        </div>
        <div className={teamStyles.headerActions}>
          {canGive && (
            <Button type="button" size="sm" leftIcon={<FiPlus aria-hidden />} onClick={() => setGiving(true)}>
              Give a task
            </Button>
          )}
          <PeriodPicker value={period} onChange={(p) => update({ period: p })} id="employee-period" />
        </div>
      </div>
      <FreshnessLine sources={data.sources} generatedAt={data.generatedAt} />

      <div className={clsx(teamStyles.fade, isFetching && teamStyles.fading)}>
        <KpiCards against={against} cards={headlineCards(person, data.previous?.totals, person.currency, (t) => update({ tab: t }))} />
      </div>

      <div className={styles.tabBar}>
        <div className={styles.tabScroller}>
          <Tabs items={TABS} activeId={tab} onChange={(id) => update({ tab: id as Tab })} />
        </div>
      </div>

      <div className={styles.tabBody}>
        {tab === 'overview' && (
          <>
            <SectionCard title="Activity, day by day" icon={FiTrendingUp}>
              <TrendChart period={period} filters={listFilters} views={['time', 'calls', 'emails', 'deals']} />
            </SectionCard>
            <div className={clsx(styles.twoUp, styles.twoUpEven)}>
              <SectionCard title="Working days" icon={FiCalendar} info="First and last activity each day: the first and last minute they were active in HaiVE or on a call.">
                {usage.isLoading ? (
                  <Skeleton height={140} />
                ) : recentDays.length ? (
                  <ul className={styles.signIns}>
                    {recentDays.map((d) => (
                      <li key={d.date} className={styles.signIn}>
                        <FiCalendar className={styles.signInIcon} aria-hidden />
                        <span>
                          <strong>{dayjs(d.date).format('ddd D MMM')}</strong> · {dayjs(d.firstAt).format('h:mm a')} – {dayjs(d.lastAt).format('h:mm a')} ·{' '}
                          {formatTalkTime(d.activeSeconds)} active · {d.sessions.length} session{d.sessions.length === 1 ? '' : 's'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState compact title="No measured time in this period" description="Time is measured while they use HaiVE or are on a call." />
                )}
              </SectionCard>
              <SectionCard title="Recent sign-ins" icon={FiLogIn}>
                {usage.isLoading ? (
                  <Skeleton height={140} />
                ) : signIns.length ? (
                  <ul className={styles.signIns}>
                    {signIns.slice(0, 5).map((s) => (
                      <li key={`${s.at}-${s.kind}`} className={styles.signIn}>
                        <FiLogIn className={styles.signInIcon} aria-hidden />
                        <span>
                          <strong>{dayjs(s.at).format('ddd D MMM, h:mm a')}</strong>
                          {s.device ? ` · ${s.device}` : ''} —{' '}
                          {s.signedOutAt ? `signed out ${dayjs(s.signedOutAt).format('h:mm a')}` : s.open ? 'still signed in' : 'no sign-out recorded'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState compact title="No sign-ins in this period" />
                )}
              </SectionCard>
            </div>
          </>
        )}

        {tab === 'sales' && (
          <>
            <TeamActivityKpis counts={person} onOpen={onTile} currency={person.currency} only={FIGURES.sales} />
            <SectionCard title="Deals, day by day" icon={FiTrendingUp}>
              <TrendChart period={period} filters={listFilters} views={['deals', 'revenue']} currency={person.currency} />
            </SectionCard>
            <SectionCard title="Their deals" icon={FiBriefcase}>
              <div className={teamStyles.sectionBody}>
                <SubTabs items={DEAL_VIEWS} value={dealView} onChange={setDealView} label="Which deals" />
                <ActivityList kind={dealView} period={period} filters={listFilters} showPerson={false} />
              </div>
            </SectionCard>
          </>
        )}

        {tab === 'email' && (
          <>
            <TeamActivityKpis counts={person} onOpen={onTile} only={FIGURES.email} />
            <SectionCard title="Email, day by day" icon={FiTrendingUp}>
              <TrendChart period={period} filters={listFilters} views={['emails']} />
            </SectionCard>
            <SectionCard title="Their email" icon={FiMail}>
              <div className={teamStyles.sectionBody}>
                <SubTabs items={EMAIL_VIEWS} value={emailView} onChange={setEmailView} label="Which emails" />
                <ActivityList kind={emailView} period={period} filters={listFilters} showPerson={false} />
              </div>
            </SectionCard>
          </>
        )}

        {tab === 'calls' && (
          <>
            <TeamActivityKpis counts={person} onOpen={onTile} only={FIGURES.calls} />
            <SectionCard title="Calls, day by day" icon={FiTrendingUp}>
              <TrendChart period={period} filters={listFilters} views={['calls']} />
            </SectionCard>
            <SectionCard title="Their calls" icon={FiPhone} info="Each call with its time, length and direction; a recorded call opens its summary, AI Coach report and recording.">
              <div className={teamStyles.sectionBody}>
                <SubTabs items={CALL_VIEWS} value={callView} onChange={setCallView} label="Which calls" />
                <ActivityList kind="calls" period={period} filters={{ ...listFilters, callFilter: callView === 'all' ? undefined : callView }} showPerson={false} />
              </div>
            </SectionCard>
          </>
        )}

        {tab === 'usage' &&
          (usage.isLoading ? (
            <Skeleton height={320} />
          ) : usage.isError || !usage.data ? (
            <EmptyState icon={FiAlertTriangle} title="App usage couldn’t be loaded" description="Please try again in a moment." />
          ) : (
            <PersonUsageView report={usage.data} />
          ))}

        {tab === 'tasks' && (
          <SectionCard title="Tasks & follow-ups" icon={FiCheckSquare}>
            <ActivityList kind="follow_ups" period={period} filters={listFilters} showPerson={false} />
          </SectionCard>
        )}
      </div>

      <ActivityListModal
        kind={openList?.list ?? null}
        onClose={() => setOpenList(null)}
        period={period}
        filters={{ ...listFilters, callFilter: openList?.callFilter }}
        showPerson={false}
        subtitle={openList ? `${person.name} — ${openList.meaning}` : undefined}
      />
      <GiveTaskModal person={giving ? person : null} onClose={() => setGiving(false)} />
    </div>
  );
}
