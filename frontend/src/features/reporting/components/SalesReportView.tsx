import { FiAward, FiCalendar, FiDollarSign, FiInfo, FiTrendingUp, FiUsers } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { formatINR as money } from '@/utils/currency';
import type { SalesReportGroupRow, SalesReportSummary } from '@/services/salesReportService';
import { KpiRow, ReportTable, type ReportColumn } from './ReportParts';
import styles from '../reporting.module.css';

const GROUP_LABEL: Record<string, string> = { customer: 'Customer', user: 'User', quoteOwner: 'Quote Owner' };

export function SalesReportView({ report }: { report: SalesReportSummary }) {
  const groupLabel = GROUP_LABEL[report.groupBy];
  const top = [...report.groups].sort((a, b) => b.totalSalesExTax - a.totalSalesExTax)[0];
  const range = `${dayjs(report.dateFrom).format('D MMM YYYY')} – ${dayjs(report.dateTo).format('D MMM YYYY')}`;

  const columns: ReportColumn<SalesReportGroupRow>[] = [
    { key: 'label', label: groupLabel, value: (r) => r.groupLabel, render: (r) => <span className={styles.rowLabel}>{r.groupLabel}</span> },
    { key: 'total', label: 'Total (ex tax)', numeric: true, value: (r) => r.totalSalesExTax, render: (r) => money(r.totalSalesExTax) },
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
          <FiCalendar aria-hidden /> {range} · Won-deal revenue, grouped by {groupLabel.toLowerCase()}.
        </div>
      </div>

      <KpiRow
        items={[
          { label: 'Total sales', value: money(report.totalSalesForPeriod), icon: FiDollarSign, hint: 'Excluding tax' },
          { label: `${groupLabel}s with sales`, value: report.groups.length, icon: FiUsers, tone: 'success' },
          {
            label: `Top ${groupLabel.toLowerCase()}`,
            value: top ? <span className={styles.kpiText}>{top.groupLabel}</span> : '—',
            hint: top ? `${money(top.totalSalesExTax)} · ${top.percentOfSales}% of sales` : 'No sales yet',
            icon: FiAward,
            tone: 'warning',
          },
        ]}
      />

      {report.dataSourceNote && (
        <div className={styles.note}>
          <FiInfo aria-hidden />
          <span>{report.dataSourceNote}</span>
        </div>
      )}

      {report.groups.length === 0 ? (
        <EmptyState icon={FiTrendingUp} title="No won deals in this period" description="Try a wider date range." />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.groups}
          rowKey={(r) => r.groupKey}
          defaultSort={{ key: 'total', dir: 'desc' }}
          searchPlaceholder={`Search ${groupLabel.toLowerCase()}s`}
          filename={`sales-per-${report.groupBy}-${report.dateFrom}-to-${report.dateTo}.csv`}
        />
      )}
    </div>
  );
}
