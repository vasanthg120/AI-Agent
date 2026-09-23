import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  FiBarChart2,
  FiCloud,
  FiCreditCard,
  FiDownload,
  FiFileText,
  FiPercent,
  FiTag,
  FiTrendingUp,
  FiTruck,
  FiUpload,
  FiUsers,
  FiZap,
} from 'react-icons/fi';
import { Button, Dropdown, MultiSelectDropdown, SectionCard, Skeleton, StatTile, Tabs } from '@/components/ui';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/api/socketClient';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR as money } from '@/utils/currency';
import { financeDocumentsService, type FinanceDocument, type FinanceFilters } from '@/services/financeDocumentsService';
import { financeDashboardService, type FinancePreset } from '@/services/financeDashboardService';
import { FinanceFilterBar } from './components/FinanceFilterBar';
import { FinanceSavedViewsBar } from './components/FinanceSavedViewsBar';
import { FinanceSummaryPanel } from './components/FinanceSummaryPanel';
import { FinanceDocumentUpload } from './components/FinanceDocumentUpload';
import { FinanceDocumentReviewModal } from './components/FinanceDocumentReviewModal';
import { FinanceDocumentListView } from './components/FinanceDocumentListView';
import { MonthlyExpenseTrendChart } from './components/MonthlyExpenseTrendChart';
import { RankedBreakdownList } from './components/RankedBreakdownList';
import styles from './finance.module.css';

const WIDGET_OPTIONS = [
  { value: 'summary', label: 'Summary KPIs' },
  { value: 'monthlyExpenseTrend', label: 'Monthly Expense Trend' },
  { value: 'vendorSpending', label: 'Vendor-wise Spending' },
  { value: 'categorySpending', label: 'Category-wise Spending' },
  { value: 'microsoftSubscriptionCosts', label: 'Microsoft Subscription Costs' },
  { value: 'deliveryShippingCosts', label: 'Delivery & Shipping Costs' },
  { value: 'taxBreakdown', label: 'Tax Breakdown' },
  { value: 'paymentMethodBreakdown', label: 'Payment Method Breakdown' },
  { value: 'recentDocuments', label: 'Recent Documents' },
];

// Grouped into tabs so Summary/AI Insight/Trend show first without every
// spending breakdown competing for space at once — the same crowding fix
// applied to Deal Performance.
const TAB_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'spending', label: 'Spending Breakdown' },
  { id: 'documents', label: 'Documents' },
];

interface DrillDown {
  title: string;
  filters: FinanceFilters;
}

// A wholly separate page, mirroring deal-performance/DealPerformancePage.tsx's
// composition shape exactly (composite overview endpoint, 60s poll +
// keepPreviousData, state-swap drill-down, saved views). Owner/admin only —
// vendor bank details and payment amounts are more sensitive than deal
// pipeline data (see Phase 10a plan notes).
export function FinancePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<FinanceFilters>({});
  const [hiddenWidgets, setHiddenWidgets] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);
  const [reviewDoc, setReviewDoc] = useState<FinanceDocument | null>(null);

  // Arrived here from a notification click (see
  // frontend/src/utils/notificationTarget.ts) — fetched directly by id
  // rather than relying on it being present in whatever page/filter of
  // `data` below happens to be loaded.
  useEffect(() => {
    const openDocumentId = searchParams.get('openDocumentId');
    if (!openDocumentId) return;
    financeDocumentsService
      .getOne(openDocumentId)
      .then(setReviewDoc)
      .catch((error) => toast.error(extractErrorMessage(error)));
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('openDocumentId');
      return next;
    }, { replace: true });
  }, [searchParams]);

  // Real-time nudge: the upload pipeline notifies owners/admins via the
  // existing notification socket channel once extraction completes: a
  // small page-scoped listener invalidates the overview query on that
  // specific event, on top of the existing 60s poll (house convention) —
  // no new WebSocket gateway needed (see Phase 10a plan notes).
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    const socket = getSocket(token);
    const handler = (n: { source?: string }) => {
      if (n.source === 'finance-document-processed') {
        void queryClient.invalidateQueries({ queryKey: ['finance-dashboard-overview'] });
      }
    };
    socket.on('notification', handler);
    return () => {
      socket.off('notification', handler);
    };
  }, [queryClient]);

  const { data: presets = [] } = useQuery({ queryKey: ['finance-presets'], queryFn: () => financeDashboardService.listPresets() });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['finance-dashboard-overview', filters],
    queryFn: () => financeDashboardService.getOverview(filters),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const isVisible = (key: string) => !hiddenWidgets.includes(key);

  const handleApplyPreset = (preset: FinancePreset) => {
    setFilters(preset.filters);
    setHiddenWidgets(preset.hiddenWidgets);
    toast.success(`Applied "${preset.name}"`);
  };

  const handleSavePreset = async (name: string) => {
    try {
      await financeDashboardService.createPreset({ name, filters, hiddenWidgets });
      await queryClient.invalidateQueries({ queryKey: ['finance-presets'] });
      toast.success('View saved');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleDeletePreset = async (id: string) => {
    try {
      await financeDashboardService.deletePreset(id);
      await queryClient.invalidateQueries({ queryKey: ['finance-presets'] });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    try {
      await financeDocumentsService.downloadExport(format, filters);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  // Also invalidates the Vendor Profitability dashboard's transaction table
  // (a different route/page, but one global QueryClient — see
  // AppProviders.tsx) so linking/editing a vendor invoice here is reflected
  // there immediately, without a manual refresh.
  const refreshOverview = () => {
    void queryClient.invalidateQueries({ queryKey: ['finance-dashboard-overview'] });
    void queryClient.invalidateQueries({ queryKey: ['dash-vendor-profitability-transactions'] });
  };

  const handleGenerateSummary = async (regenerate: boolean) => {
    const { summary } = await financeDashboardService.generateSummary(regenerate);
    queryClient.setQueryData<typeof data>(['finance-dashboard-overview', filters], (prev) =>
      prev ? { ...prev, aiGeneratedSummary: summary } : prev,
    );
  };

  if (drillDown) {
    return (
      <div className={styles.page}>
        <FinanceDocumentListView
          title={drillDown.title}
          filters={drillDown.filters}
          onBack={() => setDrillDown(null)}
          onSelectDocument={setReviewDoc}
        />
        <FinanceDocumentReviewModal
          open={!!reviewDoc}
          document={reviewDoc}
          onClose={() => setReviewDoc(null)}
          onSaved={refreshOverview}
          onDeleted={refreshOverview}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.pageTitle}>Finance AI</div>
          <div className={styles.pageSubtitle}>
            {data ? `${data.summary.totalVendorPayments.count} document(s) in view · ${data.reviewQueueCount} awaiting review` : 'Loading…'}
          </div>
        </div>
        <div className={styles.headerActions}>
          <MultiSelectDropdown label="Hidden Widgets" options={WIDGET_OPTIONS} selected={hiddenWidgets} onChange={setHiddenWidgets} />
          <Dropdown
            trigger={
              <Button type="button" variant="ghost" size="sm" leftIcon={<FiDownload />}>
                Export
              </Button>
            }
            items={[
              { id: 'csv', label: 'Export as CSV', onSelect: () => void handleExport('csv') },
              { id: 'xlsx', label: 'Export as Excel', onSelect: () => void handleExport('xlsx') },
              { id: 'pdf', label: 'Export as PDF', onSelect: () => void handleExport('pdf') },
            ]}
          />
        </div>
      </div>

      <FinanceSavedViewsBar
        presets={presets}
        onApply={handleApplyPreset}
        onDelete={(id) => void handleDeletePreset(id)}
        onSaveNew={(name) => void handleSavePreset(name)}
      />

      <SectionCard title="Upload Vendor Payment Documents" icon={FiUpload}>
        <FinanceDocumentUpload
          onDocumentReady={(doc) => {
            refreshOverview();
            setReviewDoc(doc);
          }}
        />
      </SectionCard>

      <FinanceFilterBar filters={filters} onChange={setFilters} />

      {isLoading || !data ? (
        <>
          <Skeleton height={100} />
          <Skeleton height={220} />
          <Skeleton height={160} />
        </>
      ) : (
        <>
          <div className={styles.aiInsightCard}>
            <span className={styles.aiInsightLabel}>
              <FiZap size={14} /> AI Insight
            </span>
            <span className={styles.aiInsightText}>{data.aiInsight}</span>
          </div>

          <div className={styles.tabBar}>
            <Tabs items={TAB_ITEMS} activeId={activeTab} onChange={setActiveTab} />
          </div>

          <div className={clsx(styles.tabContent, isFetching && styles.fetching)}>
            {activeTab === 'overview' && (
              <>
                <FinanceSummaryPanel summary={data.aiGeneratedSummary} onGenerate={handleGenerateSummary} />

                {isVisible('summary') && (
                  <SectionCard title="Summary" icon={FiBarChart2}>
                    <div className={styles.statsGrid}>
                      <StatTile
                        value={`${data.summary.totalVendorPayments.count} (${money(data.summary.totalVendorPayments.value)})`}
                        label="Total Vendor Payments"
                        onClick={() => setDrillDown({ title: 'All Documents', filters })}
                      />
                      <StatTile value={money(data.summary.totalExpenses.value)} label="Total Expenses" />
                      <StatTile
                        value={`${data.summary.paymentsMade.count} (${money(data.summary.paymentsMade.value)})`}
                        label="Payments Made"
                        onClick={() => setDrillDown({ title: 'Paid', filters: { ...filters, paymentStatus: ['paid'] } })}
                      />
                      <StatTile
                        value={`${data.summary.pendingPayments.count} (${money(data.summary.pendingPayments.value)})`}
                        label="Pending Payments"
                        onClick={() => setDrillDown({ title: 'Pending / Overdue', filters: { ...filters, paymentStatus: ['pending', 'overdue'] } })}
                      />
                      <StatTile
                        value={`${data.summary.upcomingDuePayments.count} (${money(data.summary.upcomingDuePayments.value)})`}
                        label="Upcoming Due"
                      />
                    </div>
                  </SectionCard>
                )}

                {isVisible('monthlyExpenseTrend') && (
                  <SectionCard title="Monthly Expense Trend" icon={FiTrendingUp}>
                    <MonthlyExpenseTrendChart points={data.monthlyExpenseTrend} />
                  </SectionCard>
                )}
              </>
            )}

            {activeTab === 'spending' && (
              <>
                <div className={styles.twoColumn}>
                  {isVisible('vendorSpending') && (
                    <SectionCard title="Vendor-wise Spending (Top Vendors)" icon={FiUsers}>
                      <RankedBreakdownList
                        items={data.vendorSpending.breakdown.map((b) => ({ key: b.key, label: b.key, value: b.value, valueFormatted: money(b.value) }))}
                        emptyMessage="No documents tagged with a vendor yet."
                        coverageNote={`${data.vendorSpending.taggedCount} of ${data.vendorSpending.totalCount} documents tagged (${data.vendorSpending.coveragePct}%)`}
                        onSelect={(key) => setDrillDown({ title: `Vendor: ${key}`, filters: { ...filters, vendorName: [key] } })}
                      />
                    </SectionCard>
                  )}
                  {isVisible('categorySpending') && (
                    <SectionCard title="Category-wise Spending" icon={FiTag}>
                      <RankedBreakdownList
                        items={data.categorySpending.breakdown.map((b) => ({ key: b.key, label: b.key, value: b.value, valueFormatted: money(b.value) }))}
                        emptyMessage="No documents tagged with a category yet."
                        coverageNote={`${data.categorySpending.taggedCount} of ${data.categorySpending.totalCount} documents tagged (${data.categorySpending.coveragePct}%)`}
                        onSelect={(key) => setDrillDown({ title: `Category: ${key}`, filters: { ...filters, expenseCategory: [key] } })}
                      />
                    </SectionCard>
                  )}
                </div>

                <div className={styles.threeColumn}>
                  {isVisible('microsoftSubscriptionCosts') && (
                    <SectionCard title="Microsoft Subscription Costs" icon={FiCloud}>
                      <div className={styles.statsGrid}>
                        <StatTile value={money(data.microsoftSubscriptionCosts.microsoftAmount)} label="Microsoft (Azure/365)" />
                        <StatTile value={money(data.microsoftSubscriptionCosts.totalAmount)} label="All Subscriptions" />
                      </div>
                    </SectionCard>
                  )}
                  {isVisible('deliveryShippingCosts') && (
                    <SectionCard title="Delivery & Shipping Costs" icon={FiTruck}>
                      <StatTile value={money(data.deliveryShippingCosts.value)} label={`${data.deliveryShippingCosts.count} document(s)`} />
                    </SectionCard>
                  )}
                  {isVisible('taxBreakdown') && (
                    <SectionCard title="Tax Breakdown" icon={FiPercent}>
                      <RankedBreakdownList
                        items={data.taxBreakdown.breakdown.map((b) => ({ key: b.key, label: b.key, value: b.value, valueFormatted: money(b.value) }))}
                        emptyMessage="No tax data captured yet."
                      />
                    </SectionCard>
                  )}
                </div>

                {isVisible('paymentMethodBreakdown') && (
                  <SectionCard title="Payment Method Breakdown" icon={FiCreditCard}>
                    <RankedBreakdownList
                      items={data.paymentMethodBreakdown.breakdown.map((b) => ({ key: b.key, label: b.key, value: b.value, valueFormatted: money(b.value) }))}
                      emptyMessage="No documents tagged with a payment method yet."
                      coverageNote={`${data.paymentMethodBreakdown.taggedCount} of ${data.paymentMethodBreakdown.totalCount} documents tagged (${data.paymentMethodBreakdown.coveragePct}%)`}
                      onSelect={(key) => setDrillDown({ title: `Payment Method: ${key}`, filters: { ...filters, paymentMethod: [key] } })}
                    />
                  </SectionCard>
                )}
              </>
            )}

            {activeTab === 'documents' && isVisible('recentDocuments') && (
              <SectionCard title="Recent Uploaded Documents" icon={FiFileText}>
                {data.recentDocuments.length === 0 ? (
                  <div className={styles.emptyState}>No documents uploaded yet.</div>
                ) : (
                  data.recentDocuments.map((d) => (
                    <div
                      key={d._id}
                      className={styles.listItem}
                      role="button"
                      tabIndex={0}
                      onClick={() => setReviewDoc(d)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setReviewDoc(d);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className={styles.listItemMain}>
                        <span className={styles.listItemTitle}>{d.vendorName ?? d.originalFilename}</span>
                        <span className={styles.listItemMeta}>{d.invoiceDate ?? 'No invoice date'}</span>
                      </div>
                      <span className={styles.rankValue}>{money(d.paymentAmount)}</span>
                    </div>
                  ))
                )}
              </SectionCard>
            )}
          </div>
        </>
      )}

      <FinanceDocumentReviewModal
        open={!!reviewDoc}
        document={reviewDoc}
        onClose={() => setReviewDoc(null)}
        onSaved={refreshOverview}
        onDeleted={refreshOverview}
      />
    </div>
  );
}
