import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Card } from '@/components/ui';
import { dealsService, type Deal } from '@/services/dealsService';
import { usePipelineDecisionCounts } from './usePipelineDecisionCounts';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from './DealStatusDistributionCard.module.css';

export interface DealStatusDistributionCardProps {
  deals: { wonCount: number; openCount: number };
  dateFrom: string;
  dateTo: string;
  storeId?: string;
}

function toRows(items: Deal[]): DrillDownRow[] {
  return items.map((d) => ({ id: d._id, title: d.name, subtitle: d.dealStatus, meta: d.expectedClosingDate, value: d.monetaryValue }));
}

// "In review" = open deals with no unapproved quote out yet (i.e. not
// waiting on a client decision) — a real, derived remainder
// (openCount - awaitingResponseCount), not an invented status value. This
// app has no third quoteStatus/clientApprovalStatus value anywhere in its
// schema or sync logic, so nothing here claims a status that doesn't exist.
export function DealStatusDistributionCard({ deals, dateFrom, dateTo, storeId }: DealStatusDistributionCardProps) {
  const { awaitingResponseCount, awaitingResponseDeals, inReviewDeals } = usePipelineDecisionCounts(dateFrom, dateTo, storeId);
  const [openRow, setOpenRow] = useState<'won' | 'awaiting' | 'review' | null>(null);
  const inReviewCount = Math.max(0, deals.openCount - awaitingResponseCount);

  const { data: wonDeals, isLoading: wonDealsLoading } = useQuery({
    queryKey: ['analytics-won-deals-list', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered({ dealStatus: ['won'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) }, 1, 100),
    enabled: openRow === 'won',
  });

  const rows = [
    { id: 'won' as const, label: 'Won', count: deals.wonCount },
    { id: 'awaiting' as const, label: 'Awaiting response', count: awaitingResponseCount },
    { id: 'review' as const, label: 'In review', count: inReviewCount },
  ];
  const max = Math.max(1, ...rows.map((r) => r.count));

  const rowData: Record<'won' | 'awaiting' | 'review', { title: string; rows: DrillDownRow[]; isLoading: boolean }> = {
    won: { title: 'Won Deals', rows: toRows(wonDeals?.items ?? []), isLoading: wonDealsLoading },
    awaiting: { title: 'Deals Awaiting Response', rows: toRows(awaitingResponseDeals), isLoading: false },
    review: { title: 'Deals In Review', rows: toRows(inReviewDeals), isLoading: false },
  };

  return (
    <Card className={styles.card}>
      <div className={styles.label}>Distribution</div>
      <div className={styles.title}>Deal status</div>

      <div className={styles.list}>
        {rows.map((row) => (
          <div key={row.id} className={styles.row} role="button" tabIndex={0} onClick={() => setOpenRow(row.id)}>
            <div className={styles.rowHeader}>
              <span className={styles.rowLabel}>{row.label}</span>
              <span className={styles.rowCount}>
                {row.count} deal{row.count === 1 ? '' : 's'}
              </span>
            </div>
            <div className={styles.track}>
              <div className={clsx(styles.fill, styles[`fill-${row.id}`])} style={{ width: `${(row.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i className={clsx(styles.dot, styles['dot-won'])} /> Won
        </span>
        <span className={styles.legendItem}>
          <i className={clsx(styles.dot, styles['dot-awaiting'])} /> Open
        </span>
        <span className={styles.legendItem}>
          <i className={clsx(styles.dot, styles['dot-review'])} /> Review
        </span>
      </div>

      <DrillDownModal
        open={!!openRow}
        onClose={() => setOpenRow(null)}
        title={openRow ? rowData[openRow].title : ''}
        isLoading={openRow ? rowData[openRow].isLoading : false}
        rows={openRow ? rowData[openRow].rows : []}
      />
    </Card>
  );
}
