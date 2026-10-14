import { FiCalendar, FiDollarSign, FiInfo, FiPercent, FiPieChart, FiTrendingUp } from 'react-icons/fi';
import { Button, EmptyState } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { formatINRExact as formatINR } from '@/utils/currency';
import type { GrossMarginReportGroupRow, GrossMarginReportSummary } from '@/services/grossMarginReportService';
import { KpiRow, ReportTable, type ReportColumn } from './ReportParts';
import styles from '../reporting.module.css';

const GROUP_LABEL: Record<string, 'Customer' | 'User'> = { customer: 'Customer', user: 'User' };

// Gross margin for a period. No cost is recorded for what is sold, so the margin
// is the organization's own percentage — set once in Settings — applied to sales
// excluding tax, and always called an estimate. Until a percentage is set the
// sales are shown and the margin is left blank, never guessed.
export function GrossMarginReportView({
  report,
  onSetMargin,
}: {
  report: GrossMarginReportSummary;
  // Opens where the percentage is set — offered to those who may set it.
  onSetMargin?: () => void;
}) {
  const notSet = <span className={styles.rowMuted}>Not set</span>;
  const dimension = GROUP_LABEL[report.groupBy];
  const range = `${dayjs(report.dateFrom).format('D MMM YYYY')} – ${dayjs(report.dateTo).format('D MMM YYYY')}`;
  const hasMargin = report.marginPct !== null;

  const columns: ReportColumn<GrossMarginReportGroupRow>[] = [
    {
      key: 'label',
      label: dimension,
      value: (r) => r.groupLabel,
      render: (r) => <span className={styles.rowLabel}>{r.groupLabel}</span>,
    },
    { key: 'quotations', label: 'Quotations', numeric: true, value: (r) => r.quotations, render: (r) => r.quotations },
    {
      key: 'exTax',
      label: 'Sales (ex tax)',
      numeric: true,
      value: (r) => r.salesExTax,
      render: (r) => formatINR(r.salesExTax),
    },
    { key: 'tax', label: 'Tax', numeric: true, value: (r) => r.tax, render: (r) => formatINR(r.tax) },
    {
      key: 'incTax',
      label: 'Sales (inc tax)',
      numeric: true,
      value: (r) => r.salesIncTax,
      render: (r) => formatINR(r.salesIncTax),
    },
    {
      key: 'margin',
      label: hasMargin ? `Gross margin (${report.marginPct}%)` : 'Gross margin',
      numeric: true,
      value: (r) => r.grossMargin ?? 0,
      render: (r) => (r.grossMargin === null ? notSet : formatINR(r.grossMargin)),
    },
  ];

  return (
    <div className={styles.reportBody}>
      <div className={styles.reportIntro}>
        <div className={styles.reportTitle}>Gross margin per {dimension.toLowerCase()}</div>
        <div className={styles.reportDescription}>
          <FiCalendar aria-hidden /> {range} ·{' '}
          {hasMargin
            ? `Estimated at ${report.marginPct}% of sales excluding tax.`
            : 'Set your gross margin percentage to see it here.'}
        </div>
      </div>

      <KpiRow
        items={[
          {
            label: 'Sales (ex tax)',
            value: formatINR(report.totalSalesExTax),
            icon: FiDollarSign,
            hint: `${report.quotations} quotation${report.quotations === 1 ? '' : 's'} sent`,
          },
          { label: 'Tax', value: formatINR(report.totalTax), icon: FiPercent, hint: 'On those quotations' },
          {
            label: 'Sales (inc tax)',
            value: formatINR(report.totalSalesIncTax),
            icon: FiTrendingUp,
            hint: 'Including tax',
          },
          {
            label: 'Gross margin (estimate)',
            value: report.grossMargin === null ? 'Not set' : formatINR(report.grossMargin),
            hint: hasMargin ? `${report.marginPct}% of sales excluding tax` : 'Needs your margin %',
            icon: FiPieChart,
            tone: hasMargin ? 'success' : 'warning',
          },
        ]}
      />

      {report.note && (
        <div className={styles.note}>
          <FiInfo aria-hidden />
          <span>{report.note}</span>
          {onSetMargin && (
            <Button type="button" size="sm" variant="secondary" onClick={onSetMargin}>
              {hasMargin ? 'Change margin %' : 'Set margin %'}
            </Button>
          )}
        </div>
      )}

      {report.groups.length === 0 ? (
        <EmptyState icon={FiPercent} title="No quotations sent in this period" description="Try a wider date range." />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.groups}
          rowKey={(r) => r.groupKey}
          defaultSort={{ key: 'exTax', dir: 'desc' }}
          searchPlaceholder={`Search ${dimension.toLowerCase()}s`}
          filename={`gross-margin-per-${report.groupBy}-${report.dateFrom}-to-${report.dateTo}.csv`}
        />
      )}
    </div>
  );
}
