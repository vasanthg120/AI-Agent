import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { AnimatedNumber, Card } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import { countedMonths } from '../countedMonths';
import { usePipelineHealth } from '../usePipelineHealth';
import styles from './KeyStatsGrid.module.css';

type OpenDrilldown = 'conversion' | 'pipeline' | 'health' | null;

export interface KeyStatsGridProps {
  deals: { wonCount: number; lostCount: number; openCount: number; openValue: number };
  businessHealthScore: number | null;
  revenueTrend: { period: string; achieved: number }[];
  dateFrom: string;
  dateTo: string;
  storeId?: string;
  onDealsClick?: () => void;
}

// Deals Won / Conversion / Business Health / Pipeline mirror data the
// Overview tab already fetches (AnalyticsDashboardOverview.deals/revenue/
// revenueTrend). How many of the month's open deals are past their closing
// date is the one thing that payload doesn't carry, so this reads those
// deals itself (the same real endpoint the Pipeline & Quotes tab uses)
// rather than inventing numbers.
//
// The fourth box used to be "Outstanding": every quotation created in the
// period, minus what was paid. No payment is recorded against a quotation
// that comes from the CRM and none carries a due date, so it showed
// everything quoted as though it were owed. It is now the pipeline of the
// chosen period — open deals expected to close in it — which is the same
// figure the "Overall Pipeline" section shows for that month.
export function KeyStatsGrid({ deals, businessHealthScore, revenueTrend, dateFrom, dateTo, storeId, onDealsClick }: KeyStatsGridProps) {
  const [openDrilldown, setOpenDrilldown] = useState<OpenDrilldown>(null);

  const { data: closedDealsResult, isLoading: closedDealsLoading } = useQuery({
    queryKey: ['analytics-closed-deals', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['won', 'lost'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
    enabled: openDrilldown === 'conversion',
  });

  const { data: openDeals } = useQuery({
    queryKey: ['analytics-open-deals-aging', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        // The deals in the Pipeline box's figure: open, or a CRM's work in progress (Hoops).
        { inPipeline: true, dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
    enabled: openDrilldown === 'pipeline',
  });

  // Counted in the database for every open deal (usePipelineHealth) — it used
  // to be counted here from the first 100 only.
  const { data: health } = usePipelineHealth(dateFrom, dateTo, storeId);
  const overdueCount = health?.pastDue.count ?? 0;
  const pendingCount = health?.onTime.count ?? 0;
  const overdueValue = health?.pastDue.value ?? 0;

  const totalDeals = deals.wonCount + deals.lostCount + deals.openCount;
  const closedDeals = deals.wonCount + deals.lostCount;
  const conversionPct = closedDeals > 0 ? Math.round((deals.wonCount / closedDeals) * 100) : null;

  const period = countedMonths(dateFrom, dateTo).label;
  // What's in the pipeline: open deals — or, for a CRM like Hoops, its work in
  // progress — counted by the server (pipeline health); the overview's open
  // figures only until that has loaded (they are the same deals for most CRMs).
  const pipelineCount = health?.open.count ?? deals.openCount;
  const pipelineValue = health?.open.value ?? deals.openValue;
  const hasPipeline = pipelineCount > 0;
  const pipelineFooter = !health ? 'Loading…' : overdueCount > 0 ? `${money(overdueValue)} past due` : 'Nothing past due';

  const closedDealRows: DrillDownRow[] = (closedDealsResult?.items ?? []).map((d) => ({
    id: d._id,
    title: d.name,
    subtitle: d.dealStatus,
    meta: d.expectedClosingDate,
    value: d.monetaryValue,
  }));

  const pipelineRows: DrillDownRow[] = (openDeals?.items ?? []).map((d) => ({
    id: d._id,
    title: d.name,
    subtitle: d.dealStatus,
    meta: d.expectedClosingDate,
    value: d.monetaryValue,
  }));

  const trendRows: DrillDownRow[] = revenueTrend.map((t, i) => ({ id: `${t.period}-${i}`, title: t.period, value: t.achieved }));

  return (
    <div className={styles.grid}>
      <Card interactive={!!onDealsClick} onClick={onDealsClick} className={styles.cell}>
        <div className={styles.label}>Deals Won</div>
        <div className={styles.value}>
          <AnimatedNumber value={deals.wonCount} />
        </div>
        <div className={styles.caption}>of {totalDeals} deals in range</div>
        <div className={styles.divider} />
        <div className={styles.footer}>
          {overdueCount} overdue · {pendingCount} pending
        </div>
      </Card>

      <Card className={styles.cell} interactive onClick={() => setOpenDrilldown('conversion')}>
        <div className={styles.label}>Conversion</div>
        <div className={styles.value}>
          {conversionPct !== null ? <AnimatedNumber value={conversionPct} format={(n) => `${Math.round(n)}%`} /> : '—'}
        </div>
        <div className={styles.caption}>won / closed deals</div>
        <div className={styles.divider} />
        <div className={styles.footer}>
          {deals.lostCount} {deals.lostCount === 1 ? 'deal' : 'deals'} lost in {period}
        </div>
      </Card>

      <Card className={styles.cell} interactive={revenueTrend.length > 1} onClick={revenueTrend.length > 1 ? () => setOpenDrilldown('health') : undefined}>
        <div className={styles.label}>Business Health</div>
        <div className={styles.value}>{businessHealthScore !== null ? <AnimatedNumber value={businessHealthScore} /> : '—'}</div>
        <div className={styles.caption}>composite score out of 100</div>
        {revenueTrend.length > 1 && (
          <div className={styles.sparkline}>
            <ResponsiveContainer width="100%" height={36}>
              <AreaChart data={revenueTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                <Area type="monotone" dataKey="achieved" stroke="var(--brand-accent-primary)" strokeWidth={2} fill="var(--color-accent-muted)" dot={false} animationDuration={900} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className={styles.cell} interactive={hasPipeline} onClick={hasPipeline ? () => setOpenDrilldown('pipeline') : undefined}>
        <div className={styles.label}>Pipeline · {period}</div>
        <div className={styles.value}>
          <AnimatedNumber value={pipelineValue} format={money} />
        </div>
        <div className={styles.caption}>
          {hasPipeline ? `${pipelineCount} ${pipelineCount === 1 ? 'deal' : 'deals'} in the pipeline` : 'Nothing in the pipeline'}
        </div>
        <div className={styles.divider} />
        <div className={health && overdueCount > 0 ? styles.footerWarn : styles.footerOk}>{pipelineFooter}</div>
      </Card>

      <DrillDownModal
        open={openDrilldown === 'conversion'}
        onClose={() => setOpenDrilldown(null)}
        title="Closed Deals (Won + Lost)"
        isLoading={closedDealsLoading}
        rows={closedDealRows}
      />
      <DrillDownModal
        open={openDrilldown === 'pipeline'}
        onClose={() => setOpenDrilldown(null)}
        title={`Pipeline — ${period}`}
        isLoading={!openDeals}
        rows={pipelineRows}
        totalCount={openDeals?.total}
      />
      <DrillDownModal
        open={openDrilldown === 'health'}
        onClose={() => setOpenDrilldown(null)}
        title="Revenue Trend (Business Health Input)"
        isLoading={false}
        rows={trendRows}
      />
    </div>
  );
}
