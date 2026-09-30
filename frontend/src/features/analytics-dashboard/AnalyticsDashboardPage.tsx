import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAward, FiGrid, FiLayers, FiMail, FiPieChart, FiSliders, FiTarget, FiTruck, FiUsers } from 'react-icons/fi';
import { Avatar, Button, EmptyState, SectionCard, Skeleton, Tabs } from '@/components/ui';
import { MetricGate, SourceLine } from '@/components/data-sources/MetricGate';
import type { DateRange } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { ROUTES } from '@/constants/routes';
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
import { MonthlySalesPerformanceCard } from './components/MonthlySalesPerformanceCard';
import { KeyStatsGrid } from './components/KeyStatsGrid';
import { RevenueMomentumCard } from './components/RevenueMomentumCard';
import { ActionQueueCard } from './components/ActionQueueCard';
import { DealsNeedingDecisionTable } from './components/DealsNeedingDecisionTable';
import { PipelineHealthCard } from './components/PipelineHealthCard';
import { DealFunnelCard } from './components/DealFunnelCard';
import { DealStatusDistributionCard } from './components/DealStatusDistributionCard';
import { TeamPerformanceSummaryCards } from './components/TeamPerformanceSummaryCards';
import { EmailResponseSlaTable } from './components/EmailResponseSlaTable';
import { SlaDashboardSection } from './components/SlaDashboardSection';
import { CustomizeDashboardModal } from './components/CustomizeDashboardModal';
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
// Profitability stays as its own tab — genuinely different sensitivity
// tier, not redundant with anything else here.
// Which metrics each tab shows — for the "Source:" line under the tabs.
const TAB_METRICS: Record<string, string[]> = {
  overview: ['revenue', 'convertedDeals', 'activePipeline', 'outstandingDues'],
  pipeline: ['activePipeline', 'totalDeals', 'quoteAcceptance'],
  team: ['teamPerformance', 'emailsResponded'],
  customers: ['customers', 'emailsSent', 'missedEmails'],
  'bi-vendor': ['vendorProfitability'],
};

const TAB_ITEMS = [
  { id: 'overview', label: 'Overview', icon: <FiGrid /> },
  { id: 'pipeline', label: 'Pipeline & Quotes', icon: <FiLayers /> },
  { id: 'team', label: 'Team Performance', icon: <FiUsers /> },
  { id: 'customers', label: 'Customers & Email', icon: <FiMail /> },
  // Owner/admin only — matches vendor-profitability.controller.ts's own
  // tighter RBAC tier (margin data is more sensitive than pipeline data).
  { id: 'bi-vendor', label: 'Vendor Profitability', icon: <FiTruck />, requireRoles: ['owner', 'admin'] },
];

// One line per tab saying which question it answers, shown under the tab bar
// so nobody has to click through all five to find the right one.
const TAB_INTRO: Record<string, string> = {
  overview: 'How the month is going — revenue against target, momentum, and what needs a decision today.',
  pipeline: 'Where every deal stands — how they move from opportunity to won, and which quotes got accepted.',
  team: 'Who is closing what — revenue per person, workload, and how fast emails get answered.',
  customers: 'Who you are selling to — new versus returning customers, and conversations waiting on a reply.',
  'bi-vendor': 'Which vendors make you money — margin per vendor and the invoices behind it.',
};

// Every card with the arrow badge in its corner opens the records behind its number.
const CLICK_HINT = 'Tip: click any card or bar to see the records behind it.';

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
  const navigate = useNavigate();
  const canOverrideStore = hasRole(user, 'owner') || hasRole(user, 'admin');

  const [range, setRange] = useState<DateRange>(defaultRange());
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const dateFrom = range.dateFrom ?? defaultRange().dateFrom!;
  const dateTo = range.dateTo ?? defaultRange().dateTo!;
  const [activeTab, setActiveTab] = useState('overview');
  const [customizeOpen, setCustomizeOpen] = useState(false);
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
        {
          dateFrom,
          dateTo,
          ...(drillDown.clientApprovalStatus ? { clientApprovalStatus: drillDown.clientApprovalStatus } : {}),
        },
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
        <motion.p
          key={activeTab}
          className={styles.tabIntro}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          {TAB_INTRO[activeTab]} <span className={styles.tabHint}>{CLICK_HINT}</span>
        </motion.p>
        <div className={styles.sourceStrip}>
          <SourceLine metrics={TAB_METRICS[activeTab] ?? []} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<FiSliders />}
            onClick={() => setCustomizeOpen(true)}
          >
            Customize
          </Button>
        </div>
      </div>

      {isLoading || !data ? (
        <div className={styles.tabContent}>
          <Skeleton height={110} />
          <div className={styles.statsGrid}>
            <Skeleton height={260} />
            <Skeleton height={260} />
          </div>
          <div className={styles.twoColumn}>
            <Skeleton height={200} />
            <Skeleton height={200} />
          </div>
        </div>
      ) : (
        <>
          <AiBriefingCard insights={data.insights} dataUpdatedAt={dataUpdatedAt} onAction={setActiveTab} />

          <motion.div
            key={activeTab}
            className={styles.tabContent}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {activeTab === 'overview' && (
              <div className={styles.tabContent}>
                <SectionCard title="Key Business Overview" icon={FiTarget} glass>
                  <p className={styles.sectionNote}>
                    Sales targets are set per calendar month — this section reflects the month selected above.
                  </p>
                  <div className={styles.statsGrid}>
                    <MetricGate metric="revenue">
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
                    </MetricGate>
                    <MetricGate metric="convertedDeals">
                      <KeyStatsGrid
                        deals={data.deals}
                        businessHealthScore={data.revenue.businessHealthScore}
                        revenueTrend={data.revenueTrend}
                        dateFrom={dateFrom}
                        dateTo={dateTo}
                        storeId={canOverrideStore ? storeId : undefined}
                        onDealsClick={() =>
                          setDrillDown({
                            kind: 'deals',
                            title: 'Won Deals',
                            dealStatus: ['won'],
                            dateField: 'expectedClosingDate',
                          })
                        }
                      />
                    </MetricGate>
                  </div>
                </SectionCard>

                <div className={styles.twoColumn}>
                  <MetricGate metric="revenue">
                    <RevenueMomentumCard
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                      storeId={canOverrideStore ? storeId : undefined}
                    />
                  </MetricGate>
                  <ActionQueueCard
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                    newEnquiryCount={data.emailActivity.newEnquiryCount}
                    // The dedicated "AI Follow-Ups" tab was removed — this
                    // queue item still surfaces the org's most-overdue
                    // follow-up (ActionQueueCard's own data/logic is
                    // untouched). It used to land back on Overview (the tab
                    // it was clicked from, so it looked dead); the AI Email
                    // Inbox's own Follow-ups section is where they live now.
                    onOpenFollowUps={() => navigate(ROUTES.emailIntelligence)}
                    onOpenPipeline={() => setActiveTab('pipeline')}
                    onOpenCustomers={() => setActiveTab('customers')}
                  />
                </div>

                <MetricGate metric="activePipeline">
                  <DealsNeedingDecisionTable
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                    ownerNames={ownerNames}
                  />
                </MetricGate>
              </div>
            )}

            {activeTab === 'pipeline' && (
              <div className={styles.tabContent}>
                <MetricGate metric="activePipeline">
                  <PipelineHealthCard
                    deals={data.deals}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                  />
                </MetricGate>

                <div className={styles.twoColumn}>
                  <MetricGate metric="totalDeals">
                    <DealFunnelCard
                      deals={data.deals}
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                      storeId={canOverrideStore ? storeId : undefined}
                    />
                  </MetricGate>
                  <MetricGate metric="totalDeals">
                    <DealStatusDistributionCard
                      deals={data.deals}
                      dateFrom={dateFrom}
                      dateTo={dateTo}
                      storeId={canOverrideStore ? storeId : undefined}
                    />
                  </MetricGate>
                </div>

                <div className={styles.twoColumn}>
                  <MetricGate metric="convertedDeals">
                    <SectionCard title="Deals: Won / Lost / Pipeline" icon={FiPieChart} glass>
                      <DealSplitDonut
                        totalLabel="deals in this range"
                        segments={[
                          { key: 'won', label: 'Won', value: data.deals.wonCount, color: 'var(--color-success)' },
                          { key: 'lost', label: 'Lost', value: data.deals.lostCount, color: 'var(--color-danger)' },
                          {
                            key: 'open',
                            label: 'Pipeline',
                            value: data.deals.openCount,
                            color: 'var(--brand-accent-primary)',
                          },
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
                  </MetricGate>

                  <MetricGate metric="quoteAcceptance">
                    <SectionCard title="Quotes: Accepted / Not Accepted" icon={FiPieChart} glass>
                      <DealSplitDonut
                        totalLabel="quotes in this range"
                        segments={[
                          {
                            key: 'accepted',
                            label: 'Accepted',
                            value: data.quotes.acceptedCount,
                            color: 'var(--color-success)',
                          },
                          {
                            key: 'not-accepted',
                            label: 'Not Accepted',
                            value: data.quotes.notAcceptedCount,
                            color: 'var(--brand-accent-primary)',
                          },
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
                  </MetricGate>
                </div>
              </div>
            )}

            {activeTab === 'team' && (
              <div className={styles.tabContent}>
                <MetricGate metric="teamPerformance">
                  <TeamPerformanceSummaryCards
                    data={data}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                  />
                </MetricGate>

                <MetricGate metric="teamPerformance">
                  <SectionCard title="Employee Leaderboard" icon={FiUsers} glass>
                    {data.employeeLeaderboard.length === 0 ? (
                      <EmptyState compact icon={FiUsers} title="No sales team members in scope for this period" />
                    ) : (
                      data.employeeLeaderboard.map((r, i) => (
                        <motion.div
                          key={r.userId}
                          className={clsx(styles.listItem, styles.leaderRow)}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.035 }}
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
                          <span
                            className={clsx(styles.rankBadge, i < 3 && r.revenue > 0 && styles[`rankBadge${i + 1}`])}
                          >
                            {i < 3 && r.revenue > 0 ? <FiAward /> : i + 1}
                          </span>
                          <Avatar name={r.userName} size="sm" />
                          <div className={styles.listItemMain} style={{ flex: 1 }}>
                            <span className={styles.listItemTitle}>{r.userName}</span>
                            <div className={styles.leaderTrack}>
                              <motion.div
                                className={styles.leaderFill}
                                initial={{ width: 0 }}
                                animate={{
                                  width: `${(r.revenue / Math.max(1, data.employeeLeaderboard[0]?.revenue ?? 1)) * 100}%`,
                                }}
                                transition={{
                                  duration: 0.8,
                                  ease: [0.16, 1, 0.3, 1],
                                  delay: 0.1 + Math.min(i, 10) * 0.035,
                                }}
                              />
                            </div>
                            <span className={styles.listItemMeta}>
                              {r.wonCount} deal{r.wonCount === 1 ? '' : 's'} won
                            </span>
                          </div>
                          <strong className={styles.leaderValue}>{money(r.revenue)}</strong>
                        </motion.div>
                      ))
                    )}
                  </SectionCard>
                </MetricGate>

                {/* Work Completion & Productivity — a strict superset of the
                    old "Sales Work Breakdown" table (deals AND emails AND
                    quotes per employee, not deals alone), so that table was
                    retired rather than kept alongside a now-redundant view. */}
                <ProductivitySection
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  storeId={canOverrideStore ? storeId : undefined}
                />

                <MetricGate metric="emailsResponded">
                  <EmailResponseSlaTable
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    storeId={canOverrideStore ? storeId : undefined}
                  />
                </MetricGate>

                <SlaDashboardSection userNames={ownerNames} />
              </div>
            )}

            {activeTab === 'customers' && (
              <CustomersAndEmailSection
                dateFrom={dateFrom}
                dateTo={dateTo}
                storeId={canOverrideStore ? storeId : undefined}
              />
            )}

            {activeTab === 'bi-vendor' && (
              <MetricGate metric="vendorProfitability">
                <VendorProfitabilitySection dateFrom={dateFrom} dateTo={dateTo} />
              </MetricGate>
            )}
          </motion.div>
        </>
      )}

      <CustomizeDashboardModal open={customizeOpen} onClose={() => setCustomizeOpen(false)} />

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
