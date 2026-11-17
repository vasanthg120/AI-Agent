import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AnimatedNumber, Card } from '@/components/ui';
import { pressable } from '@/utils/pressable';
import { formatINR as money } from '@/utils/currency';
import { dealsService, type Deal, type DealFilters } from '@/services/dealsService';
import { countedMonths } from '../countedMonths';
import { usePipelineHealth } from '../usePipelineHealth';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './PipelineHealthCard.module.css';

function toRows(items: Deal[]): DrillDownRow[] {
  return items.map((d) => ({ id: d._id, dealId: d._id, title: d.name, subtitle: d.dealStatus, meta: d.expectedClosingDate, value: d.monetaryValue }));
}

type OpenDrilldown = 'total' | 'won' | 'pastDue' | null;

export interface PipelineHealthCardProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Pipeline Health for the period — the deals expected to close in its months:
// the open pipeline and how much of it is past its closing date, then all
// deals, won, past due and win rate. Every figure comes from one aggregate
// (usePipelineHealth, shared with the Overview's Pipeline box); the lists
// behind them load only when opened.
//
// Before 2026-11-10 the headline was "total outstanding" (every quote in the
// period minus payments — with no payments recorded, simply everything ever
// quoted, approved or rejected), overdue was counted in the browser from the
// first 100 open deals only, and the card made two requests up front.
export function PipelineHealthCard({ dateFrom, dateTo, storeId }: PipelineHealthCardProps) {
  const [openDrilldown, setOpenDrilldown] = useState<OpenDrilldown>(null);
  const { data: health } = usePipelineHealth(dateFrom, dateTo, storeId);
  const period = countedMonths(dateFrom, dateTo).label;

  const base: DealFilters = { dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) };
  const { data: list, isLoading: listLoading } = useQuery({
    queryKey: ['analytics-pipeline-health-list', openDrilldown, dateFrom, dateTo, storeId, health?.today],
    queryFn: () =>
      dealsService.listFiltered(
        openDrilldown === 'won'
          ? { ...base, dealStatus: ['won'] }
          : openDrilldown === 'pastDue'
            ? { ...base, dealStatus: ['open'], closingBefore: health!.today }
            : base,
        1,
        100,
      ),
    enabled: openDrilldown !== null && !!health,
  });

  const open = health?.open ?? { count: 0, value: 0 };
  const pastDue = health?.pastDue ?? { count: 0, value: 0 };
  const onTime = health?.onTime ?? { count: 0, value: 0 };
  const totalDeals = health ? health.open.count + health.won.count + health.lost.count : 0;
  const pastDuePct = open.value > 0 ? Math.max(0, Math.min(100, (pastDue.value / open.value) * 100)) : 0;
  const titles: Record<Exclude<OpenDrilldown, null>, string> = {
    total: `All Deals — ${period}`,
    won: `Won Deals — ${period}`,
    pastDue: `Past-Due Open Deals — ${period}`,
  };

  return (
    <Card className={styles.card}>
      <div className={styles.mainCol}>
        <div className={styles.label}>Pipeline Health · {period}</div>
        <div className={styles.valueRow}>
          <span className={styles.value}>{health ? <AnimatedNumber value={open.value} format={money} /> : '—'}</span>
          <span className={styles.valueLabel}>
            open pipeline · {open.count} {open.count === 1 ? 'deal' : 'deals'}
          </span>
        </div>
        <div
          className={styles.progressTrack}
          role="img"
          aria-label={health ? `${money(onTime.value)} on time, ${money(pastDue.value)} past due` : 'Loading'}
        >
          <div className={styles.progressFill} style={{ width: `${open.value > 0 ? 100 - pastDuePct : 0}%` }} />
          <div className={styles.progressPastDue} style={{ width: `${pastDuePct}%` }} />
        </div>
        <div className={styles.progressLabels}>
          <span>{money(onTime.value)} on time</span>
          <span className={clsx(pastDue.count > 0 && styles.pastDueText)}>
            {pastDue.count > 0 ? `${money(pastDue.value)} past due (${Math.round(pastDuePct)}%)` : 'Nothing past due'}
          </span>
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.statsCol}>
        <div className={styles.stat} {...pressable(() => setOpenDrilldown('total'))}>
          <div className={styles.statValue}>
            <AnimatedNumber value={totalDeals} />
          </div>
          <div className={styles.statLabel}>total deals</div>
        </div>
        <div className={styles.stat} {...pressable(() => setOpenDrilldown('won'))}>
          <div className={styles.statValue}>
            <AnimatedNumber value={health?.won.count ?? 0} />
          </div>
          <div className={styles.statLabel}>won</div>
        </div>
        <div className={styles.stat} {...pressable(() => setOpenDrilldown('pastDue'))}>
          <div className={clsx(styles.statValue, pastDue.count > 0 && styles.pastDueText)}>
            <AnimatedNumber value={pastDue.count} />
          </div>
          <div className={styles.statLabel}>past due</div>
        </div>
        <div className={styles.statStatic}>
          <div className={styles.statValue}>{health?.winRatePct != null ? `${Math.round(health.winRatePct)}%` : '—'}</div>
          <div className={styles.statLabel}>win rate</div>
        </div>
      </div>

      {openDrilldown && (
        <DrillDownModal
          open
          onClose={() => setOpenDrilldown(null)}
          title={titles[openDrilldown]}
          isLoading={listLoading}
          rows={toRows(list?.items ?? [])}
          totalCount={list?.total}
        />
      )}
    </Card>
  );
}
