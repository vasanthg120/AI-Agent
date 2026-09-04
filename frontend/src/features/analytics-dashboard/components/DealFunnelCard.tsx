import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui';
import { dealsService, type Deal } from '@/services/dealsService';
import { usePipelineDecisionCounts } from './usePipelineDecisionCounts';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './DealFunnelCard.module.css';

export interface DealFunnelCardProps {
  deals: { wonCount: number; lostCount: number; openCount: number };
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

function toRows(items: Deal[]): DrillDownRow[] {
  return items.map((d) => ({ id: d._id, title: d.name, subtitle: d.dealStatus, meta: d.expectedClosingDate, value: d.monetaryValue }));
}

type StageKey = 'all' | 'open' | 'awaiting' | 'won';

// A real 4-step funnel, not the generic "Qualified"/"Proposal Sent"-style
// stage names a CRM template might show — this app has no stage-name data
// at all (Deal.stageId is an opaque external-CRM id with no label anywhere
// in the system, confirmed against both schema and sync code). Every step
// here is instead a real, always-populated bucket: total deals, still-open,
// open-with-an-unapproved-quote, and won.
export function DealFunnelCard({ deals, dateFrom, dateTo, storeId }: DealFunnelCardProps) {
  const { awaitingResponseCount, awaitingResponseDeals, openDeals } = usePipelineDecisionCounts(dateFrom, dateTo, storeId);
  const [openStage, setOpenStage] = useState<StageKey | null>(null);
  const totalDeals = deals.wonCount + deals.lostCount + deals.openCount;

  const { data: allDeals, isLoading: allDealsLoading } = useQuery({
    queryKey: ['analytics-all-deals', dateFrom, dateTo, storeId],
    queryFn: () => dealsService.listFiltered({ dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) }, 1, 100),
    enabled: openStage === 'all',
  });
  const { data: wonDeals, isLoading: wonDealsLoading } = useQuery({
    queryKey: ['analytics-won-deals-list', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered({ dealStatus: ['won'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) }, 1, 100),
    enabled: openStage === 'won',
  });

  const stages: { key: StageKey; label: string; count: number }[] = [
    { key: 'all', label: 'All opportunities', count: totalDeals },
    { key: 'open', label: 'Open', count: deals.openCount },
    { key: 'awaiting', label: 'Awaiting response', count: awaitingResponseCount },
    { key: 'won', label: 'Won', count: deals.wonCount },
  ];
  const max = Math.max(1, totalDeals);

  const stageRows: Record<StageKey, DrillDownRow[]> = {
    all: toRows(allDeals?.items ?? []),
    open: toRows(openDeals),
    awaiting: toRows(awaitingResponseDeals),
    won: toRows(wonDeals?.items ?? []),
  };
  const stageLoading: Record<StageKey, boolean> = { all: allDealsLoading, open: false, awaiting: false, won: wonDealsLoading };
  const stageTitle: Record<StageKey, string> = {
    all: 'All Opportunities',
    open: 'Open Deals',
    awaiting: 'Deals Awaiting Response',
    won: 'Won Deals',
  };

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.label}>Conversion View</div>
          <div className={styles.title}>
            Deal movement
          </div>
        </div>
        <span className={styles.period}>This period</span>
      </div>

      <div className={styles.funnel}>
        {stages.map((stage, i) => (
          <div
            key={stage.key}
            className={styles.bar}
            role="button"
            tabIndex={0}
            onClick={() => setOpenStage(stage.key)}
            style={{ width: `${Math.max(12, (stage.count / max) * 100)}%`, background: `color-mix(in srgb, var(--brand-accent-primary) ${30 + i * 22}%, var(--color-accent-muted))` }}
          >
            <span className={styles.barLabel}>{stage.label}</span>
            <span className={styles.barCount}>{stage.count}</span>
          </div>
        ))}
      </div>

      <DrillDownModal
        open={!!openStage}
        onClose={() => setOpenStage(null)}
        title={openStage ? stageTitle[openStage] : ''}
        isLoading={openStage ? stageLoading[openStage] : false}
        rows={openStage ? stageRows[openStage] : []}
      />
    </Card>
  );
}
