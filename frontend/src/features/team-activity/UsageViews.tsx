import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiActivity, FiAlertTriangle, FiCalendar, FiClock, FiGrid, FiInfo, FiLogIn, FiMonitor, FiPhone, FiPieChart, FiUsers } from 'react-icons/fi';
import { Avatar, EmptyState, SectionCard, Skeleton } from '@/components/ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { formatTalkTime, teamActivityService, type TeamPeriodValue, type TeamUsageReport, type UsageArea, type UsagePerson } from '@/services/teamActivityService';
import { UsageDaysChart } from './ActivityCharts';
import { ConnectedApps, KpiCards, ShareBars, StatusLabel, type ShareRow } from './EmployeeParts';
import { AREA_LABELS, areaColor } from './usageAreas';
import { activityStatus, changePct } from './status';
import styles from './EmployeeActivity.module.css';
import teamStyles from './TeamActivity.module.css';

const CALLS_COLOR = 'var(--color-text-secondary)';

/** Parts of HaiVE by time, then time on calls — the numbers written out beside each bar. */
function areaRows(areas: { key: UsageArea; seconds: number }[], callSeconds: number): ShareRow[] {
  const total = areas.reduce((s, a) => s + a.seconds, 0) + callSeconds;
  const share = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : undefined);
  return [
    ...areas.map((a) => ({ key: a.key, label: AREA_LABELS[a.key], value: a.seconds, color: areaColor(a.key), display: formatTalkTime(a.seconds), extra: share(a.seconds) })),
    ...(callSeconds > 0 ? [{ key: 'on-calls', label: 'On calls', value: callSeconds, color: CALLS_COLOR, display: formatTalkTime(callSeconds), extra: share(callSeconds) }] : []),
  ];
}

/** Says when measuring began, if that is inside the period: before then only calls count. */
function MeasuredSinceNote({ report }: { report: TeamUsageReport }) {
  const from = report.businesses.reduce((min, b) => (!min || b.from < min ? b.from : min), '');
  const since = report.measuredSince ? dayjs(report.measuredSince) : null;
  if (since && since.format('YYYY-MM-DD') <= from) return null;
  return (
    <div className={styles.note} role="note">
      <FiInfo aria-hidden />
      <span>
        {since
          ? `Time in HaiVE has been measured since ${since.format('D MMM YYYY, h:mm a')}. Before that, only time on calls is known.`
          : 'Time in HaiVE starts being measured as people use it — nothing has been recorded in these businesses yet. Time on calls is known already.'}{' '}
        Nothing is counted while HaiVE sits open untouched: only a click, key press, scroll or touch in the last 2 minutes keeps the clock running.
      </span>
    </div>
  );
}

const when = (iso?: string, withDay = false) => (iso ? dayjs(iso).format(withDay ? 'D MMM, h:mm a' : 'h:mm a') : '—');

/** Each person's measured time: total, per day worked, first and last activity, and where it mostly went. */
function UsagePeopleTable({ people, showBusiness, multiDay, onOpen }: { people: UsagePerson[]; showBusiness: boolean; multiDay: boolean; onOpen: (p: UsagePerson) => void }) {
  const narrow = useMediaQuery('(max-width: 900px)');
  if (people.length === 0) return <EmptyState compact title="Nobody to show yet" />;
  const sub = (p: UsagePerson) => [p.role, showBusiness ? p.businessName : undefined].filter(Boolean).join(' · ');
  const figures = (p: UsagePerson) => [
    { label: 'Active time', value: formatTalkTime(p.activeSeconds) },
    ...(multiDay
      ? [
          { label: 'Per day worked', value: p.avgActiveSecondsPerDay === null ? '—' : formatTalkTime(p.avgActiveSecondsPerDay) },
          { label: 'Days', value: String(p.activeDays) },
        ]
      : []),
    { label: 'First activity', value: when(p.firstAt, multiDay) },
    { label: 'Last activity', value: when(p.lastAt, multiDay) },
    { label: 'Mostly in', value: p.topArea ? AREA_LABELS[p.topArea] : p.callSeconds > 0 ? 'Calls' : '—' },
  ];
  if (narrow) {
    return (
      <ul className={teamStyles.personCards}>
        {people.map((p) => (
          <li key={`${p.businessId}-${p.userId}`}>
            <button type="button" className={teamStyles.personCard} onClick={() => onOpen(p)}>
              <span className={teamStyles.personCell}>
                <Avatar name={p.name} size="sm" status={activityStatus(p.lastActiveAt).tone === 'now' ? 'online' : undefined} />
                <span className={teamStyles.personText}>
                  <span className={teamStyles.personName}>{p.name}</span>
                  <span className={teamStyles.personSub}>
                    <StatusLabel lastActiveAt={p.lastActiveAt} />
                  </span>
                </span>
              </span>
              <span className={teamStyles.personFigures}>
                {figures(p).map((f) => (
                  <span key={f.label} className={teamStyles.personFigure}>
                    <span className={teamStyles.personFigureLabel}>{f.label}</span>
                    <strong>{f.value}</strong>
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={teamStyles.tableWrap}>
      <table className={teamStyles.table}>
        <thead>
          <tr>
            <th>Employee</th>
            {figures(people[0]).map((f) => (
              <th key={f.label} className={f.label === 'Mostly in' ? undefined : teamStyles.num}>
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr
              key={`${p.businessId}-${p.userId}`}
              className={clsx(teamStyles.row, !p.active && teamStyles.rowInactive)}
              tabIndex={0}
              onClick={() => onOpen(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(p);
                }
              }}
              aria-label={`Open ${p.name}`}
            >
              <td>
                <span className={teamStyles.personCell}>
                  <Avatar name={p.name} size="sm" status={activityStatus(p.lastActiveAt).tone === 'now' ? 'online' : undefined} />
                  <span className={teamStyles.personText}>
                    <span className={teamStyles.personName}>{p.name}</span>
                    <span className={teamStyles.personSub}>{sub(p)}</span>
                    <span className={teamStyles.personSub}>
                      <StatusLabel lastActiveAt={p.lastActiveAt} />
                    </span>
                  </span>
                </span>
              </td>
              {figures(p).map((f) => (
                <td key={f.label} className={clsx(f.label !== 'Mostly in' && teamStyles.num, p.activeSeconds === 0 && teamStyles.zero)}>
                  {f.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The team's App usage: measured time in HaiVE (by part of the app) and on calls,
// day by day and per employee, and every other app they work in with what can be
// said about it. "Active" is never "the app was open" — see the note on the page.
export function TeamUsageView({
  period,
  business,
  previousActiveSeconds,
  against,
  onOpenPerson,
}: {
  period: TeamPeriodValue;
  business: string;
  previousActiveSeconds?: number | null;
  against?: string;
  onOpenPerson: (userId: string, businessId: string) => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-activity-usage', period, business],
    queryFn: () => teamActivityService.usage(period, { organizationId: business }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  if (isLoading) {
    return (
      <div className={styles.tabBody}>
        <div className={styles.kpiGrid}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={112} />
          ))}
        </div>
        <Skeleton height={300} />
      </div>
    );
  }
  if (isError || !data) return <EmptyState icon={FiAlertTriangle} title="App usage couldn’t be loaded" description="Please try again in a moment." />;

  const { totals } = data;
  const multiDay = data.days.length > 1;
  const showBusiness = data.acrossBusinesses && business === 'all';
  const top = data.areas[0];
  return (
    <div className={styles.tabBody}>
      <KpiCards
        against={against}
        cards={[
          {
            key: 'active',
            label: 'Active time',
            icon: FiActivity,
            value: formatTalkTime(totals.activeSeconds),
            context: `${totals.activePeople} of ${totals.people} employees active`,
            change: changePct(totals.activeSeconds, previousActiveSeconds),
            title: 'HaiVE in active use, or on a call — a minute doing both counts once.',
          },
          {
            key: 'day',
            label: 'Average working day',
            icon: FiCalendar,
            value: totals.avgActiveSecondsPerPersonDay === null ? '—' : formatTalkTime(totals.avgActiveSecondsPerPersonDay),
            context: 'per person, on the days they worked',
          },
          {
            key: 'haive',
            label: 'Time in HaiVE',
            icon: FiMonitor,
            value: formatTalkTime(totals.haiveSeconds),
            context: top ? `Mostly ${top.label}` : 'Nothing measured yet',
          },
          {
            key: 'calls',
            label: 'Time on calls',
            icon: FiPhone,
            value: formatTalkTime(totals.callSeconds),
            context: 'from answer to hang-up',
          },
        ]}
      />
      <MeasuredSinceNote report={data} />
      <div className={styles.twoUp}>
        <SectionCard title="Active time, day by day" icon={FiClock}>
          <UsageDaysChart days={data.days} />
        </SectionCard>
        <SectionCard title="Where the time goes" icon={FiPieChart}>
          {data.areas.length || totals.callSeconds ? (
            <ShareBars ariaLabel="Time by part of HaiVE" rows={areaRows(data.areas, totals.callSeconds)} />
          ) : (
            <EmptyState compact title="No measured time yet" />
          )}
        </SectionCard>
      </div>
      <SectionCard
        title="Employees"
        icon={FiUsers}
        info="Measured time per employee. First and last activity are the first and last minute they were active in HaiVE or on a call."
      >
        <UsagePeopleTable people={data.people} showBusiness={showBusiness} multiDay={multiDay} onOpen={(p) => onOpenPerson(p.userId, p.businessId)} />
      </SectionCard>
      <SectionCard title="Apps your team works in" icon={FiGrid} info="HaiVE measures time only where it can see it. Other apps report what was done there, never for how long.">
        <ConnectedApps apps={data.apps} />
      </SectionCard>
    </div>
  );
}

// ---- one employee ------------------------------------------------------------------------------

const DAY_MINUTES = 24 * 60;

/** A day's work sessions on a 24-hour line, with its first and last activity. */
function DayRows({ days }: { days: NonNullable<TeamUsageReport['person']>['days'] }) {
  if (days.length === 0) return <EmptyState compact title="No measured time in this period" description="Time is measured while they use HaiVE or are on a call." />;
  return (
    <>
      <div className={styles.dayTicks} aria-hidden>
        <span />
        <span className={styles.dayTicksScale}>
          <span>12am</span>
          <span>6am</span>
          <span>12pm</span>
          <span>6pm</span>
          <span>12am</span>
        </span>
        <span />
      </div>
      <ul className={styles.dayList}>
        {[...days].reverse().map((day) => (
          <li key={day.date} className={styles.dayRow}>
            <span className={styles.dayDate}>
              {dayjs(day.date).format('ddd D MMM')}
              <small>
                {day.sessions.length} session{day.sessions.length === 1 ? '' : 's'}
              </small>
            </span>
            <span className={styles.dayTrack} role="img" aria-label={`Worked ${when(day.firstAt)} to ${when(day.lastAt)} in ${day.sessions.length} sessions`}>
              {day.sessions.map((s) => {
                const start = dayjs(s.start);
                const left = ((start.hour() * 60 + start.minute()) / DAY_MINUTES) * 100;
                const width = (dayjs(s.end).diff(start, 'minute', true) / DAY_MINUTES) * 100;
                return (
                  <span
                    key={s.start}
                    className={styles.daySession}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                    title={`${when(s.start)} – ${when(s.end)} · ${formatTalkTime(s.activeSeconds)} active`}
                  />
                );
              })}
            </span>
            <span className={styles.dayFigures}>
              <strong>{formatTalkTime(day.activeSeconds)}</strong>
              <span>
                {when(day.firstAt)} – {when(day.lastAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// One employee's App usage: where their time went, each day's sessions with first
// and last activity, their sign-ins, and the apps they work in.
export function PersonUsageView({ report }: { report: TeamUsageReport }) {
  const person = report.person;
  const days = person?.days ?? [];
  return (
    <div className={styles.tabBody}>
      <MeasuredSinceNote report={report} />
      <div className={styles.twoUp}>
        <SectionCard
          title="Working days"
          icon={FiCalendar}
          info="Each bar is a work session — a stretch of activity with no break of 15 minutes or more. Times are in your time zone."
        >
          <DayRows days={days} />
        </SectionCard>
        <SectionCard title="Where the time goes" icon={FiPieChart}>
          {report.areas.length || report.totals.callSeconds ? (
            <ShareBars ariaLabel="Time by part of HaiVE" rows={areaRows(report.areas, report.totals.callSeconds)} />
          ) : (
            <EmptyState compact title="No measured time in this period" />
          )}
        </SectionCard>
      </div>
      <SectionCard title="Sign-ins" icon={FiLogIn} info="When they signed in, on what, and when they signed out. A session that simply expired has no sign-out.">
        {person?.signIns.length ? (
          <ul className={styles.signIns}>
            {person.signIns.map((s) => (
              <li key={`${s.at}-${s.kind}`} className={styles.signIn}>
                <FiLogIn className={styles.signInIcon} aria-hidden />
                <span>
                  <strong>{s.kind === 'switch_in' ? 'Moved into this business' : 'Signed in'}</strong> {dayjs(s.at).format('ddd D MMM, h:mm a')}
                  {s.device ? ` · ${s.device}` : ''}
                  {s.location ? ` · ${s.location}` : ''}
                  {' — '}
                  {s.signedOutAt
                    ? `signed out ${dayjs(s.signedOutAt).format('h:mm a')}`
                    : s.open
                      ? 'still signed in'
                      : s.kind === 'switch_in'
                        ? 'left when they switched or signed out'
                        : 'no sign-out recorded'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title="No sign-ins in this period" description="Sign-ins are recorded from now on; a session opened earlier shows while it is still open." />
        )}
      </SectionCard>
      <SectionCard title="Apps they work in" icon={FiGrid}>
        <ConnectedApps apps={report.apps} />
      </SectionCard>
    </div>
  );
}
