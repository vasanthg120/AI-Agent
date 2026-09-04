import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FiPieChart, FiTarget, FiUsers } from 'react-icons/fi';
import { InfoPopover, SectionCard, Skeleton, Tabs } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { formatINR as money } from '@/utils/currency';
import { organizationsService } from '@/services/organizationsService';
import { analyticsDashboardService } from '@/services/analyticsDashboardService';
import { dealsService } from '@/services/dealsService';
import { quotesService } from '@/services/quotesService';
import { DealSplitDonut } from './components/DealSplitDonut';
import { DashboardHeroHeader } from './components/DashboardHeroHeader';
import { AiBriefingCard } from './components/AiBriefingCard';
import { CustomersAndEmailSection } from './components/CustomersAndEmailSection';
import { DrillDownModal, type DrillDownRow } from './components/DrillDownModal';
import { ProductivitySection } from './components/ProductivitySection';
import { VendorProfitabilitySection } from './components/VendorProfitabilitySection';
import { AiFollowupSummarySection } from './components/AiFollowupSummarySection';
import { MonthlySalesPerformanceCard } from './components/MonthlySalesPerformanceCard';
import { KeyStatsGrid } from './components/KeyStatsGrid';
import { RevenueMomentumCard } from './components/RevenueMomentumCard';
import { ActionQueueCard } from './components/ActionQueueCard';
import { DealsNeedingDecisionTable } from './components/DealsNeedingDecisionTable';
import { QuotesLedgerTable } from './components/QuotesLedgerTable';
import { PipelineHealthCard } from './components/PipelineHealthCard';
import { DealFunnelCard } from './components/DealFunnelCard';
import { DealStatusDistributionCard } from './components/DealStatusDistributionCard';
import { TeamPerformanceSummaryCards } from './components/TeamPerformanceSummaryCards';
import { EmailResponseSlaTable } from './components/EmailResponseSlaTable';
import { SlaDashboardSection } from './components/SlaDashboardSection';
import styles from './analytics-dashboard.module.css';

// Local-calendar-date formatter — deliberately NOT `.toISOString().slice(0,10)`,
// which converts to UTC first: a Date constructed at LOCAL midnight on the
// 1st of the month lands on the 31st of the PREVIOUS month once read back in
// UTC for any timezone ahead of UTC (e.g. IST, UTC+5:30), silently corrupting
// the "current month" default into a two-month-spanning range. Real bug,
// confirmed live (dashboard defaulted to "Jul 31 – Aug 14" and the month
// picker showed "July" while today was in August). Reading the same
// getFullYear/getMonth/getDate the Date was built from guarantees no drift
// regardless of the browser's timezone.
function fmtLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Defaults to the current month (start of month through today), never "all
// time" — matches MonthYearFilterPopup's own current-month rendering, so the
// popup's initial label/selection is correct without any extra sync logic.
function defaultRange(): DateRange {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return { dateFrom: fmtLocalDate(startOfMonth), dateTo: fmtLocalDate(now) };
}

// Consolidated (see each tab's own comment for what folded in where) — down
// from 10 tabs to 6. Every BI section still exists and fetches the exact
// same real endpoints; only the navigation surface changed, driven by a
// direct "too many tabs, too much redundancy" correction. Sent/Missed Email
// Analytics folded into Customers & Email (that tab already showed the same
// summary numbers, just a thinner version); Employee Productivity folded
// into Team Performance (a strict superset of the old Won/Lost/Open table);
// Enquiry Conversion and Quotes & Payments folded into Pipeline & Quotes
// (all three are "what happened to this quote" questions). Vendor
// Profitability and AI Follow-Ups stay as their own tabs — genuinely
// different sensitivity tier / interaction pattern, not redundant with
// anything else here.
const TAB_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline & Quotes' },
  { id: 'team', label: 'Team Performance' },
  { id: 'customers', label: 'Customers & Email' },
  // Owner/admin only — matches vendor-profitability.controller.ts's own
  // tighter RBAC tier (margin data is more sensitive than pipeline data).
  { id: 'bi-vendor', label: 'Vendor Profitability', requireRoles: ['owner', 'admin'] },
  { id: 'bi-followups', label: 'AI Follow-Ups' },
];

// One-line-per-tab explainer shown next to the tab bar — what this page as a
// whole covers, before drilling into any one card/table/chart's own
// InfoPopover. Keyed by TAB_ITEMS' own ids so a missing entry is a build-time
// TS error, not a silently blank popover.
const TAB_DESCRIPTIONS: Record<(typeof TAB_ITEMS)[number]['id'], string> = {
  overview: 'A single-glance summary of the month: revenue against target, deal/conversion/outstanding stats, momentum, and what needs attention next.',
  pipeline: 'Every open, won, and lost deal in the selected period, plus the full quotes ledger — how the pipeline is moving and what quotes are outstanding.',
  team: "How the sales team is performing: revenue and deals won, each member's workload completion, and email response SLAs.",
  customers: 'Who your customers are this period (new, existing, lost) and how the inbox is keeping up (replied vs. missed emails, open enquiries).',
  'bi-vendor': 'Gross margin by deal — customer revenue vs. paid vendor cost, for orgs that link vendor invoices to deals. Owner/admin only.',
  'bi-followups': "Today's AI-prioritized follow-ups: overdue and due-today customer actions, high-priority accounts, and ready-to-send draft replies.",
};

type DrillDownTarget =
  | {
      kind: 'deals';
      title: string;
      dealStatus?: ('open' | 'won' | 'lost')[];
      ownerId?: string[];
      dateField?: 'createdAt' | 'expectedClosingDate';
    }
  | { kind: 'quotes'; title: string; clientApprovalStatus?: 'approved' | 'not-approved' };

// Phase 19 — replaces the Owner/Manager/Consultant Home Dashboard views as
// the single /dashboard experience for every business-hierarchy role. One
// page, one endpoint (GET /analytics-dashboard/overview) — the backend
// resolves org/store/personal scope from the caller's own role/JWT, never a
// client-supplied scope beyond the owner/admin-only store override below.
export function AnalyticsDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const canOverrideStore = hasRole(user, 'owner') || hasRole(user, 'admin');

  const [range, setRange] = useState<DateRange>(defaultRange());
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const dateFrom = range.dateFrom ?? defaultRange().dateFrom!;
  const dateTo = range.dateTo ?? defaultRange().dateTo!;
  const [activeTab, setActiveTab] = useState('overview');
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [drillDown, setDrillDown] = useState<DrillDownTarget | null>(null);

  const visibleTabs = TAB_ITEMS.filter((t) => !t.requireRoles || t.requireRoles.some((r) => hasRole(user, r)));

  useEffect(() => {
    if (!canOverrideStore) return;
    void (async () => {
      try {
        const storeList = await organizationsService.listStores();
        setStores(storeList.map((s) => ({ id: s._id, name: s.name })));
      } catch {
        setStores([]);
      }
    })();
  }, [canOverrideStore]);

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['analytics-dashboard-overview', dateFrom, dateTo, storeId],
    queryFn: () => analyticsDashboardService.getOverview(dateFrom, dateTo, storeId),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // userId -> name, for resolving Deal.ownerId in DealsNeedingDecisionTable.
  // Built from this same response's own team-activity fields (never a
  // separate admin-only user lookup, which would 403 for manager/consultant
  // viewers of this page) — employeeLeaderboard and workBreakdown iterate
  // the same team roster but aren't guaranteed identical coverage, so both
  // are merged.
  const ownerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data?.employeeLeaderboard ?? []) map.set(r.userId, r.userName);
    for (const r of data?.workBreakdown ?? []) map.set(r.userId, r.userName);
    return map;
  }, [data]);

  // Every real record shown in the drill-down modal comes from the same
  // real endpoints the rest of the app already uses (dealsService/
  // quotesService) — this dashboard never invents or duplicates data, only
  // surfaces it. Owner/admin's store override is passed through so a
  // filtered dashboard view drills into a matching filtered list, never a
  // wider org-wide one. (Email drill-downs now live directly on the
  // Customers & Email tab's own full-list view, not this generic modal.)
  const { data: drillItems, isLoading: drillLoading } = useQuery({
    queryKey: ['analytics-dashboard-drilldown', drillDown, dateFrom, dateTo, storeId],
    queryFn: async (): Promise<DrillDownRow[]> => {
      if (!drillDown) return [];

      if (drillDown.kind === 'deals') {
        const result = await dealsService.listFiltered(
          {
            dateFrom,
            dateTo,
            ...(drillDown.dateField ? { dateField: drillDown.dateField } : {}),
            ...(drillDown.dealStatus ? { dealStatus: drillDown.dealStatus } : {}),
            ...(drillDown.ownerId ? { ownerId: drillDown.ownerId } : {}),
            ...(canOverrideStore && storeId ? { storeId: [storeId] } : {}),
          },
          1,
          100,
        );
        return result.items.map((d) => ({
          id: d._id,
          title: d.name,
          subtitle: d.dealStatus,
          meta: d.expectedClosingDate,
          value: d.monetaryValue,
        }));
      }

      const result = await quotesService.listFiltered(
        { dateFrom, dateTo, ...(drillDown.clientApprovalStatus ? { clientApprovalStatus: drillDown.clientApprovalStatus } : {}) },
        1,
        100,
      );
      return result.items.map((q) => ({
        id: q._id,
        title: q.quoteName || q.quoteNumber || 'Untitled quote',
        subtitle: q.clientDetails?.companyName,
        meta: q.clientApprovalStatus,
        value: q.quoteAmount,
      }));
    },
    enabled: !!drillDown,
  });

  return (
    <div className={styles.page}>
      <DashboardHeroHeader
        firstName={user?.firstName}
        range={range}
        onRangeChange={setRange}
        dateFrom={dateFrom}
        dateTo={dateTo}
        storeId={storeId}
        onStoreChange={setStoreId}
        stores={stores}
        canOverrideStore={canOverrideStore}
      />

      <div className={styles.tabBar}>
        <Tabs items={visibleTabs} activeId={activeTab} onChange={setActiveTab} />
        <InfoPopover title={visibleTabs.find((t) => t.id === activeTab)?.label ?? ''} align="right" label="What is this?">
          <p>{TAB_DESCRIPTIONS[activeTab]}</p>
        </InfoPopover>
      </div>

      {isLoading || !data ? (
        <>
          <Skeleton height={100} />
          <Skeleton height={220} />
        </>
      ) : (
        <>
          <AiBriefingCard insights={data.insights} dataUpdatedAt={dataUpdatedAt} onAction={setActiveTab} />

          {activeTab === 'overview' && (
            <div className={styles.tabContent}>
              <SectionCard title="Key Business Overview" icon={FiTarget} glass>
                <p className={styles.sectionNote}>Sales targets are set per calendar month — this section reflects the month selected above.</p>
                <div className={styles.statsGrid}>
                  <MonthlySalesPerformanceCard
                    achieved={data.revenue.achieved}
                    targetAmount={data.revenue.targetAmount}
                    achievementPct={data.revenue.achievementPct}
                    remaining={data.revenue.remaining}
                    predictedMonthEnd={data.revenue.predictedMonthEnd}
                    revenueTrend={data.revenueTrend}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onClick={() =>
                      setDrillDown({
                        kind: 'deals',
                        title: 'Won Deals (Revenue)',
                        dealStatus: ['won'],
                        // Total Revenue itself is summed by expectedClosingDate
                        // (SalesAnalyticsService.getAchievement), not createdAt —
                        // match that field here so the list reconciles with the
                        // figure that was clicked, instead of showing a
                        // createdAt-scoped set that can span unrelated months.
                        dateField: 'expectedClosingDate',
                      })
                    }
                  />
                  <KeyStatsGrid
                    deals={data.deals}
                    businessHealthScore={data.revenue.businessHealthScore}
                    revenueTrend={data.revenueTrend}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                    onDealsClick={() => setDrillDown({ kind: 'deals', title: 'Won Deals', dealStatus: ['won'], dateField: 'expectedClosingDate' })}
                  />
                </div>
              </SectionCard>

              <div className={styles.twoColumn}>
                <RevenueMomentumCard dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />
                <ActionQueueCard
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  storeId={canOverrideStore ? storeId : undefined}
                  newEnquiryCount={data.emailActivity.newEnquiryCount}
                  onOpenFollowUps={() => setActiveTab('bi-followups')}
                  onOpenPipeline={() => setActiveTab('pipeline')}
                  onOpenCustomers={() => setActiveTab('customers')}
                />
              </div>

              <DealsNeedingDecisionTable
                dateFrom={dateFrom}
                dateTo={dateTo}
                storeId={canOverrideStore ? storeId : undefined}
                ownerNames={ownerNames}
              />
            </div>
          )}

          {activeTab === 'pipeline' && (
            <div className={styles.tabContent}>
              <PipelineHealthCard deals={data.deals} dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />

              <div className={styles.twoColumn}>
                <DealFunnelCard deals={data.deals} dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />
                <DealStatusDistributionCard deals={data.deals} dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />
              </div>

              <div className={styles.twoColumn}>
                <SectionCard
                  title="Deals: Won / Lost / Pipeline"
                  icon={FiPieChart}
                  glass
                  info={
                    <p>
                      Every deal in the selected period split by status. Click a slice or legend to see the underlying list.
                      Counts are scoped by expected closing date, matching the figure you'd click into.
                    </p>
                  }
                >
                  <DealSplitDonut
                    totalLabel="deals in this range"
                    segments={[
                      { key: 'won', label: 'Won', value: data.deals.wonCount, color: 'var(--color-success)' },
                      { key: 'lost', label: 'Lost', value: data.deals.lostCount, color: 'var(--color-danger)' },
                      { key: 'open', label: 'Pipeline', value: data.deals.openCount, color: 'var(--brand-accent-primary)' },
                    ]}
                    onSelectSegment={(key) =>
                      setDrillDown({
                        kind: 'deals',
                        title: key === 'won' ? 'Won Deals' : key === 'lost' ? 'Lost Deals' : 'Open Pipeline',
                        dealStatus: [key as 'won' | 'lost' | 'open'],
                        // Same fix as the Won vs Lost Revenue chart above —
                        // this donut's own won/lost/open counts are now
                        // expectedClosingDate-scoped, so the drill-down must
                        // match or it shows every deal instead of this
                        // period's.
                        dateField: 'expectedClosingDate',
                      })
                    }
                  />
                </SectionCard>

                <SectionCard
                  title="Quotes: Accepted / Not Accepted"
                  icon={FiPieChart}
                  glass
                  info={
                    <p>
                      Every quote in the selected period, split by <strong>Accepted</strong> (client approval status is
                      Approved) vs. <strong>Not Accepted</strong> (anything else — Pending, Rejected, etc.). Click a slice or
                      legend to see the underlying list.
                    </p>
                  }
                >
                  <DealSplitDonut
                    totalLabel="quotes in this range"
                    segments={[
                      { key: 'accepted', label: 'Accepted', value: data.quotes.acceptedCount, color: 'var(--color-success)' },
                      { key: 'not-accepted', label: 'Not Accepted', value: data.quotes.notAcceptedCount, color: 'var(--brand-accent-primary)' },
                    ]}
                    onSelectSegment={(key) =>
                      setDrillDown({
                        kind: 'quotes',
                        title: key === 'accepted' ? 'Accepted Quotes' : 'Quotes Not Yet Accepted',
                        clientApprovalStatus: key === 'accepted' ? 'approved' : 'not-approved',
                      })
                    }
                  />
                </SectionCard>
              </div>

              <QuotesLedgerTable dateFrom={dateFrom} dateTo={dateTo} />
            </div>
          )}

          {activeTab === 'team' && (
            <div className={styles.tabContent}>
              <TeamPerformanceSummaryCards data={data} dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />

              <SectionCard
                title="Employee Leaderboard"
                icon={FiUsers}
                glass
                info={
                  <p>
                    Every sales team member in scope, ranked by revenue from deals they own marked Won in this period. Click a
                    row to see that person's won deals.
                  </p>
                }
              >
                {data.employeeLeaderboard.length === 0 ? (
                  <div className={styles.emptyState}>No sales team members in scope for this period.</div>
                ) : (
                  data.employeeLeaderboard.map((r, i) => (
                    <div
                      key={r.userId}
                      className={styles.listItem}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        setDrillDown({
                          kind: 'deals',
                          title: `${r.userName}'s Won Deals`,
                          dealStatus: ['won'],
                          ownerId: [r.userId],
                          // Leaderboard revenue is now expectedClosingDate-
                          // scoped too (same getConsultantPerformance call,
                          // fed the fixed dealMatch) — same fix as the two
                          // drill-downs above, for the same reason.
                          dateField: 'expectedClosingDate',
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setDrillDown({
                          kind: 'deals',
                          title: `${r.userName}'s Won Deals`,
                          dealStatus: ['won'],
                          ownerId: [r.userId],
                          dateField: 'expectedClosingDate',
                        });
                      }}
                    >
                      <div className={styles.listItemMain}>
                        <span className={styles.rankBadge}>{i + 1}</span>
                      </div>
                      <div className={styles.listItemMain} style={{ flex: 1 }}>
                        <span className={styles.listItemTitle}>{r.userName}</span>
                        <span className={styles.listItemMeta}>{r.wonCount} deal(s) won</span>
                      </div>
                      <strong>{money(r.revenue)}</strong>
                    </div>
                  ))
                )}
              </SectionCard>

              {/* Work Completion & Productivity — a strict superset of the
                  old "Sales Work Breakdown" table (deals AND emails AND
                  quotes per employee, not deals alone), so that table was
                  retired rather than kept alongside a now-redundant view. */}
              <ProductivitySection dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />

              <EmailResponseSlaTable dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />

              <SlaDashboardSection />
            </div>
          )}

          {activeTab === 'customers' && (
            <CustomersAndEmailSection dateFrom={dateFrom} dateTo={dateTo} storeId={canOverrideStore ? storeId : undefined} />
          )}

          {activeTab === 'bi-vendor' && <VendorProfitabilitySection dateFrom={dateFrom} dateTo={dateTo} />}
          {activeTab === 'bi-followups' && <AiFollowupSummarySection />}
        </>
      )}

      <DrillDownModal
        open={!!drillDown}
        onClose={() => setDrillDown(null)}
        title={drillDown?.title ?? ''}
        isLoading={drillLoading}
        rows={drillItems ?? []}
      />
    </div>
  );
}
