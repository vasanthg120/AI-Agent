import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService, type Deal } from '@/services/dealsService';
import { customerQuotePaymentService } from '@/services/customerQuotePaymentService';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './PipelineHealthCard.module.css';

function toRows(items: Deal[]): DrillDownRow[] {
  return items.map((d) => ({ id: d._id, title: d.name, subtitle: d.dealStatus, meta: d.expectedClosingDate, value: d.monetaryValue }));
}

type OpenDrilldown = 'total' | 'won' | 'overdue' | null;

export interface PipelineHealthCardProps {
  deals: { wonCount: number; lostCount: number; openCount: number; wonValue: number; lostValue: number; openValue: number };
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

// Reuses the exact same queryKeys as KeyStatsGrid/DealsNeedingDecisionTable's
// own open-deals and payment-summary fetches (both real, already-used
// endpoints), so React Query serves this from the same cached request
// instead of firing a duplicate one.
export function PipelineHealthCard({ deals, dateFrom, dateTo, storeId }: PipelineHealthCardProps) {
  const [openDrilldown, setOpenDrilldown] = useState<OpenDrilldown>(null);

  const { data: openDeals } = useQuery({
    queryKey: ['analytics-open-deals-aging', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['open'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
  });

  const { data: paymentSummary } = useQuery({
    queryKey: ['analytics-quote-payment-summary', dateFrom, dateTo, storeId],
    queryFn: () => customerQuotePaymentService.getSummary({ dateFrom, dateTo, ...(storeId ? { storeId: [storeId] } : {}) }),
  });

  const { data: allDeals, isLoading: allDealsLoading } = useQuery({
    queryKey: ['analytics-all-deals', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
    enabled: openDrilldown === 'total',
  });

  const { data: wonDeals, isLoading: wonDealsLoading } = useQuery({
    queryKey: ['analytics-won-deals-list', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['won'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
    enabled: openDrilldown === 'won',
  });

  const overdueCount = useMemo(() => {
    if (!openDeals) return 0;
    const today = dayjs().format('YYYY-MM-DD');
    return openDeals.items.filter((d) => d.expectedClosingDate && d.expectedClosingDate < today).length;
  }, [openDeals]);

  const overdueRows = useMemo(() => {
    if (!openDeals) return [];
    const today = dayjs().format('YYYY-MM-DD');
    return toRows(openDeals.items.filter((d) => d.expectedClosingDate && d.expectedClosingDate < today));
  }, [openDeals]);

  const totalDeals = deals.wonCount + deals.lostCount + deals.openCount;
  // "Active" = still in play — won (already realized) plus open (still
  // could be) — lost deals are excluded, they're no longer part of what's
  // active in the pipeline.
  const activeValue = deals.wonValue + deals.openValue;
  const activePct = activeValue > 0 ? Math.max(0, Math.min(100, (deals.wonValue / activeValue) * 100)) : 0;

  return (
    <Card className={styles.card}>
      <div className={styles.mainCol}>
        <div className={styles.label}>Pipeline Health</div>
        <div className={styles.valueRow}>
          <span className={styles.value}>{paymentSummary ? money(paymentSummary.totalOutstanding) : '—'}</span>
          <span className={styles.valueLabel}>total outstanding</span>
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${activePct}%` }} />
        </div>
        <div className={styles.progressLabels}>
          <span>{money(deals.wonValue)} won</span>
          <span>{Math.round(activePct)}% of active value</span>
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.statsCol}>
        <div className={styles.stat} role="button" tabIndex={0} onClick={() => setOpenDrilldown('total')}>
          <div className={styles.statValue}>{totalDeals}</div>
          <div className={styles.statLabel}>total deals</div>
        </div>
        <div className={styles.stat} role="button" tabIndex={0} onClick={() => setOpenDrilldown('won')}>
          <div className={styles.statValue}>{deals.wonCount}</div>
          <div className={styles.statLabel}>won</div>
        </div>
        <div className={styles.stat} role="button" tabIndex={0} onClick={() => setOpenDrilldown('overdue')}>
          <div className={styles.statValue}>{overdueCount}</div>
          <div className={styles.statLabel}>overdue</div>
        </div>
      </div>

      <DrillDownModal open={openDrilldown === 'total'} onClose={() => setOpenDrilldown(null)} title="All Deals in This Period" isLoading={allDealsLoading} rows={toRows(allDeals?.items ?? [])} />
      <DrillDownModal open={openDrilldown === 'won'} onClose={() => setOpenDrilldown(null)} title="Won Deals" isLoading={wonDealsLoading} rows={toRows(wonDeals?.items ?? [])} />
      <DrillDownModal open={openDrilldown === 'overdue'} onClose={() => setOpenDrilldown(null)} title="Overdue Open Deals" isLoading={false} rows={overdueRows} />
    </Card>
  );
}
