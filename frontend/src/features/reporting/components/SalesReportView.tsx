import { FiAward, FiCalendar, FiDollarSign, FiInfo, FiPercent, FiTrendingUp } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { formatINRExact as money } from '@/utils/currency';
import type { SalesReportGroupRow, SalesReportSummary } from '@/services/salesReportService';
import { KpiRow, ReportTable, type ReportColumn } from './ReportParts';
import styles from '../reporting.module.css';

const GROUP_LABEL: Record<string, string> = { customer: 'Customer', user: 'User', quoteOwner: 'Quote Owner' };

// Sales for a period: the deals won in it, at their value (the Dashboard's
// revenue) — shown excluding tax, the tax, and including tax.
export function SalesReportView({ report }: { report: SalesReportSummary }) {
  const groupLabel = GROUP_LABEL[report.groupBy];
  const range = `${dayjs(report.dateFrom).format('D MMM YYYY')} – ${dayjs(report.dateTo).format('D MMM YYYY')}`;

  const columns: ReportColumn<SalesReportGroupRow>[] = [
    {
      key: 'label',
      label: groupLabel,
      value: (r) => r.groupLabel,
      render: (r) => <span className={styles.rowLabel}>{r.groupLabel}</span>,
    },
    { key: 'deals', label: 'Deals won', numeric: true, value: (r) => r.deals, render: (r) => r.deals },
    {
      key: 'exTax',
      label: 'Sales (ex tax)',
      numeric: true,
      value: (r) => r.salesExTax,
      render: (r) => money(r.salesExTax),
    },
    { key: 'tax', label: 'Tax', numeric: true, value: (r) => r.tax, render: (r) => money(r.tax) },
    {
      key: 'incTax',
      label: 'Sales (inc tax)',
      numeric: true,
      value: (r) => r.salesIncTax,
      render: (r) => money(r.salesIncTax),
    },
    {
      key: 'share',
      label: '% of sales',
      numeric: true,
      value: (r) => r.percentOfSales,
      bar: (r) => r.percentOfSales,
      render: (r) => `${r.percentOfSales}%`,
    },
  ];

  return (
    <div className={styles.reportBody}>
      <div className={styles.reportIntro}>
        <div className={styles.reportTitle}>Sales per {groupLabel.toLowerCase()}</div>
        <div className={styles.reportDescription}>
          <FiCalendar aria-hidden /> {range} · Deals won, grouped by {groupLabel.toLowerCase()}.
        </div>
      </div>

      <KpiRow
        items={[
          { label: 'Sales (ex tax)', value: money(report.totalSalesExTax), icon: FiDollarSign, hint: 'Excluding tax' },
          { label: 'Tax', value: money(report.totalTax), icon: FiPercent, hint: 'Split as on their quotations' },
          {
            label: 'Sales (inc tax)',
            value: money(report.totalSalesIncTax),
            icon: FiTrendingUp,
            tone: 'success',
            hint: 'Including tax',
          },
          {
            label: 'Deals won',
            value: report.deals,
            icon: FiAward,
            tone: 'warning',
            hint: 'Same as the Dashboard revenue',
          },
        ]}
      />

      {/* With nothing won, the empty state below says so; the note would only repeat it. */}
      {report.dataSourceNote && report.deals > 0 && (
        <div className={styles.note}>
          <FiInfo aria-hidden />
          <span>{report.dataSourceNote}</span>
        </div>
      )}

      {report.groups.length === 0 ? (
        <EmptyState
          icon={FiTrendingUp}
          title="No deal won in this period"
          description="Try a wider date range."
        />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.groups}
          rowKey={(r) => r.groupKey}
          defaultSort={{ key: 'exTax', dir: 'desc' }}
          searchPlaceholder={`Search ${groupLabel.toLowerCase()}s`}
          filename={`sales-per-${report.groupBy}-${report.dateFrom}-to-${report.dateTo}.csv`}
        />
      )}
    </div>
  );
}
