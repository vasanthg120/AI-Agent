import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAward, FiCalendar, FiPercent, FiPieChart, FiTrendingUp } from 'react-icons/fi';
import { ChoiceCards, DateRangeControl, EmptyState, PageHeader, SectionCard, Skeleton, type DateRange } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { salesReportService } from '@/services/salesReportService';
import { grossMarginReportService } from '@/services/grossMarginReportService';
import { RoyaltyReportSection } from '@/features/royalty/components/RoyaltyReportSection';
import { SalesReportView } from './components/SalesReportView';
import { GrossMarginReportView } from './components/GrossMarginReportView';
import styles from './reporting.module.css';

type ReportType = 'sales' | 'grossMargin' | 'royalty';

// Each report explains itself on its picker card, so someone who has never
// opened this page knows which one answers their question.
const REPORT_TYPES: { id: ReportType; label: string; description: string; icon: typeof FiTrendingUp }[] = [
  { id: 'sales', label: 'Sales', description: 'Won-deal revenue by customer, user or quote owner', icon: FiTrendingUp },
  { id: 'grossMargin', label: 'Gross Margin', description: 'What you earned versus what it cost', icon: FiPercent },
  { id: 'royalty', label: 'Royalty', description: 'Royalties owed on invoices in a period', icon: FiAward },
];

const GROUP_OPTIONS: Record<'sales' | 'grossMargin', { value: string; label: string }[]> = {
  sales: [
    { value: 'customer', label: 'Per Customer' },
    { value: 'user', label: 'Per User' },
    { value: 'quoteOwner', label: 'Per Quote Owner' },
  ],
  grossMargin: [
    { value: 'salesCustomer', label: 'Sales / Customer' },
    { value: 'salesUser', label: 'Sales / User' },
    { value: 'quotesCustomer', label: 'Quotes / Customer' },
    { value: 'quotesUser', label: 'Quotes / User' },
  ],
};

const REPORT_ICON = { sales: FiTrendingUp, grossMargin: FiPercent, royalty: FiAward };

// Single-column, top-down layout — NOT a narrow left sidebar. A 300px
// sidebar was tried first but doesn't actually fit this page's controls:
// DateRangeControl's preset row (7 labels) and the Report Type/Group By
// selectors are all designed, throughout this app, to live in a WIDE
// horizontal filter bar (see DealFilterBar.tsx/FinanceFilterBar.tsx/
// RoyaltyReportSection's own filter row) — every other page already
// follows this shape, so this page now matches instead of being the one
// exception squeezing those same controls into a column too narrow for
// them (which was also the direct cause of a real Tabs.module.css bug,
// fixed separately: a vertical Tabs list could show a phantom scrollbar
// for as few as 3 items once its column got tight enough).
//
// Report Type is a horizontal Tabs row (fits 3 items easily at full page
// width). Sales/Gross Margin share one filter bar below it (DateRangeControl
// + a Group By Tabs row, both auto-refetching via React Query the instant
// either changes — no separate "Generate" click, since these are cheap
// deterministic aggregate queries, not LLM calls). Royalty renders
// RoyaltyReportSection directly, full width, with no competing filter bar
// — that component already owns its own date range/Generate/export and is
// shared with the dedicated Royalty page; nothing here should duplicate or
// visually crowd it.
export function ReportingPage() {
  const [reportType, setReportType] = useState<ReportType>('sales');
  const [range, setRange] = useState<DateRange>(() => ({
    dateFrom: dayjs().startOf('month').format('YYYY-MM-DD'),
    dateTo: dayjs().format('YYYY-MM-DD'),
  }));
  const [groupBy, setGroupBy] = useState<string>(GROUP_OPTIONS.sales[0].value);

  const handleReportTypeChange = (next: string) => {
    const nextType = next as ReportType;
    setReportType(nextType);
    if (nextType === 'sales' || nextType === 'grossMargin') setGroupBy(GROUP_OPTIONS[nextType][0].value);
  };

  const hasRange = !!range.dateFrom && !!range.dateTo;

  const { data: salesReport, isFetching: salesFetching } = useQuery({
    queryKey: ['reporting-sales', range.dateFrom, range.dateTo, groupBy],
    queryFn: () => salesReportService.generate(range.dateFrom!, range.dateTo!, groupBy as 'customer' | 'user' | 'quoteOwner'),
    enabled: reportType === 'sales' && hasRange,
    placeholderData: keepPreviousData,
  });

  const { data: grossMarginReport, isFetching: gmFetching } = useQuery({
    queryKey: ['reporting-gross-margin', range.dateFrom, range.dateTo, groupBy],
    queryFn: () =>
      grossMarginReportService.generate(
        range.dateFrom!,
        range.dateTo!,
        groupBy as 'salesCustomer' | 'salesUser' | 'quotesCustomer' | 'quotesUser',
      ),
    enabled: reportType === 'grossMargin' && hasRange,
    placeholderData: keepPreviousData,
  });

  const loading = (reportType === 'sales' && salesFetching && !salesReport) || (reportType === 'grossMargin' && gmFetching && !grossMarginReport);
  // Refetching over data that's already on screen (new range / grouping) —
  // keep showing it, dimmed, with a progress line, instead of a skeleton flash.
  const refreshing = !loading && ((reportType === 'sales' && salesFetching) || (reportType === 'grossMargin' && gmFetching));
  const ReportIcon = REPORT_ICON[reportType];

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiPieChart}
        title="Reporting"
        subtitle="Analyse your financial, customer and team performance — pick a report, choose a period, and the numbers update instantly."
      />

      <ChoiceCards
        ariaLabel="Report type"
        items={REPORT_TYPES}
        activeId={reportType}
        onChange={(id) => handleReportTypeChange(id)}
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={reportType === 'royalty' ? 'royalty' : 'aggregate'}
          className={styles.reportArea}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          {reportType === 'royalty' ? (
            <RoyaltyReportSection />
          ) : (
            <>
              <div className={styles.filterBar}>
                <div className={styles.filterGroup}>
                  <span className={styles.filterLabel}>Period</span>
                  <DateRangeControl value={range} onChange={setRange} />
                </div>
                <div className={styles.filterGroup}>
                  <span className={styles.filterLabel}>Group by</span>
                  <LayoutGroup id="report-group-by">
                    <div className={styles.segmented} role="radiogroup" aria-label="Group by">
                      {GROUP_OPTIONS[reportType].map((opt) => {
                        const active = opt.value === groupBy;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={clsx(styles.segment, active && styles.segmentActive)}
                            onClick={() => setGroupBy(opt.value)}
                          >
                            {active && (
                              <motion.span
                                layoutId="group-by-thumb"
                                className={styles.segmentThumb}
                                transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                              />
                            )}
                            <span className={styles.segmentLabel}>{opt.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </LayoutGroup>
                </div>
              </div>

              <SectionCard title="Results" icon={ReportIcon}>
                <div className={clsx(styles.results, refreshing && styles.resultsRefreshing)}>
                  {refreshing && <span className={styles.refreshBar} aria-label="Updating" />}
                  {!hasRange && (
                    <EmptyState icon={FiCalendar} title="Pick a period" description="Choose a start date and an end date to run the report." />
                  )}
                  {loading && (
                    <div className={styles.loadingBlock}>
                      <div className={styles.kpiRow}>
                        {[0, 1, 2].map((i) => (
                          <Skeleton key={i} height={104} />
                        ))}
                      </div>
                      <Skeleton height={260} />
                    </div>
                  )}
                  {!loading && hasRange && reportType === 'sales' && salesReport && <SalesReportView report={salesReport} />}
                  {!loading && hasRange && reportType === 'grossMargin' && grossMarginReport && (
                    <GrossMarginReportView report={grossMarginReport} />
                  )}
                </div>
              </SectionCard>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
