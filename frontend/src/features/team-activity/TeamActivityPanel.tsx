import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FiActivity, FiArrowRight, FiHome } from 'react-icons/fi';
import { Button, SectionCard, SelectMenu, Skeleton } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { teamActivityService, type TeamActivityPerson, type TeamPeriodValue } from '@/services/teamActivityService';
import { ActivityListModal } from './ActivityList';
import { PeriodPicker, describePeriod } from './PeriodPicker';
import { TeamActivityKpis } from './TeamActivityKpis';
import { TeamActivityTable } from './TeamActivityTable';
import type { MetricDef } from './metrics';
import styles from './TeamActivity.module.css';

/** What Agent Activity opens on when a person is clicked here. */
export interface AgentActivityLinkState {
  person?: TeamActivityPerson;
  period?: TeamPeriodValue;
}

// The Dashboard's Team Performance tab: the same figures as Agent Activity —
// deals created, emails sent / replied / not replied / missed, calls, talk
// time and call scores — for the whole team, with its own date filter (the
// Dashboard's month filter counts whole months; this one starts on Today).
// A person opens their page in Agent Activity.
export function TeamActivityPanel() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<TeamPeriodValue>({ period: 'today' });
  const [business, setBusiness] = useState('all');
  const [openList, setOpenList] = useState<MetricDef | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['team-activity', period, business],
    queryFn: () => teamActivityService.overview(period, { organizationId: business }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const businessOptions = useMemo(
    () => [{ value: 'all', label: 'All businesses' }, ...(data?.businesses ?? []).map((b) => ({ value: b.id, label: b.name }))],
    [data?.businesses],
  );

  const openPerson = (person?: TeamActivityPerson) => navigate(ROUTES.agentActivity, { state: { person, period } satisfies AgentActivityLinkState });

  return (
    <SectionCard
      title={`Team activity ${describePeriod(period)}`}
      icon={FiActivity}
      info="Deals created, emails sent and answered, emails still waiting or missed (no reply in 24 hours), calls, talk time and the AI Coach's call scores — per person. Click any number to see the records behind it."
    >
      <div className={styles.panel}>
        <div className={styles.panelBar}>
          {data?.acrossBusinesses ? (
            <SelectMenu value={business} options={businessOptions} onChange={setBusiness} ariaLabel="Business" icon={<FiHome aria-hidden />} className={styles.businessPicker} />
          ) : (
            <span />
          )}
          <PeriodPicker value={period} onChange={setPeriod} id="dashboard-team-period" />
        </div>

        {isLoading || !data ? (
          <>
            <div className={styles.kpis}>
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} height={92} />
              ))}
            </div>
            <Skeleton height={220} />
          </>
        ) : (
          <div className={clsx(styles.panel, styles.fade, isFetching && styles.fading)}>
            <TeamActivityKpis
              counts={data.totals}
              onOpen={setOpenList}
              compact
              currency={data.summary.currency}
              only={['dealsCreated', 'dealsWon', 'emailsSent', 'emailsReplied', 'emailsMissed', 'calls', 'talkSeconds', 'avgCallScore']}
            />
            {data.team && (
              <TeamActivityTable people={data.people} onSelect={openPerson} showBusiness={data.acrossBusinesses && business === 'all'} limit={8} searchable={false} columnSwitch={false} />
            )}
            <div className={styles.panelFoot}>
              <Button type="button" variant="ghost" size="sm" rightIcon={<FiArrowRight />} onClick={() => openPerson()}>
                {data.team && data.people.length > 8 ? `All ${data.people.length} people in Agent Activity` : 'Open Agent Activity'}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ActivityListModal
        kind={openList?.list ?? null}
        onClose={() => setOpenList(null)}
        period={period}
        filters={{ organizationId: business, callFilter: openList?.callFilter }}
        showPerson={!!data?.team}
        subtitle={openList?.meaning}
      />
    </SectionCard>
  );
}
