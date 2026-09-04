import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FiAward, FiPercent, FiTrendingUp } from 'react-icons/fi';
import { DateRangeControl, SectionCard, Skeleton, Tabs, type DateRange } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { salesReportService } from '@/services/salesReportService';
import { grossMarginReportService } from '@/services/grossMarginReportService';
import { RoyaltyReportSection } from '@/features/royalty/components/RoyaltyReportSection';
import { SalesReportView } from './components/SalesReportView';
import { GrossMarginReportView } from './components/GrossMarginReportView';
import styles from './reporting.module.css';

type ReportType = 'sales' | 'grossMargin' | 'royalty';

const REPORT_TYPE_TABS = [
  { id: 'sales', label: 'Sales', icon: <FiTrendingUp /> },
  { id: 'grossMargin', label: 'Gross Margin', icon: <FiPercent /> },
  { id: 'royalty', label: 'Royalty', icon: <FiAward /> },
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
  const ReportIcon = REPORT_ICON[reportType];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.pageTitle}>Reporting</div>
        <div className={styles.pageSubtitle}>Analyse your financial, customer &amp; team performance with easy reporting.</div>
      </div>

      <div className={styles.reportTypeBar}>
        <Tabs items={REPORT_TYPE_TABS} activeId={reportType} onChange={handleReportTypeChange} />
      </div>

      {reportType === 'royalty' ? (
        <RoyaltyReportSection />
      ) : (
        <>
          <div className={styles.filterBar}>
            <div className={styles.filterRow}>
              <DateRangeControl value={range} onChange={setRange} />
              <Tabs
                items={GROUP_OPTIONS[reportType].map((opt) => ({ id: opt.value, label: opt.label }))}
                activeId={groupBy}
                onChange={setGroupBy}
              />
            </div>
          </div>

          <SectionCard title="Report Results" icon={ReportIcon}>
            {!hasRange && <div className={styles.emptyState}>Choose a start date and an end date.</div>}
            {loading && <Skeleton height={320} />}
            {!loading && hasRange && reportType === 'sales' && salesReport && <SalesReportView report={salesReport} />}
            {!loading && hasRange && reportType === 'grossMargin' && grossMarginReport && (
              <GrossMarginReportView report={grossMarginReport} />
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
