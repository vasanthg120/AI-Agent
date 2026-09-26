import { FiCalendar, FiCheckCircle, FiInfo, FiPercent, FiShoppingCart, FiTrendingUp } from 'react-icons/fi';
import { EmptyState } from '@/components/ui';
import { dayjs } from '@/utils/date';
import { formatINR } from '@/utils/currency';
import type { GrossMarginReportGroupRow, GrossMarginReportSummary } from '@/services/grossMarginReportService';
import { KpiRow, ReportTable, type ReportColumn } from './ReportParts';
import styles from '../reporting.module.css';

// groupBy is "metric + dimension" combined (matches the reference report's
// 4 radios: Sales/Quotes crossed with Customer/User) — split back apart
// here purely for display.
const METRIC_LABEL: Record<string, string> = { sales: 'Sales', quotes: 'Quotes' };

function splitGroupBy(groupBy: string): { metric: string; dimension: 'Customer' | 'User' } {
  const metric = groupBy.startsWith('sales') ? 'sales' : 'quotes';
  const dimension = groupBy.endsWith('Customer') ? 'Customer' : 'User';
  return { metric, dimension };
}

// Renders real numbers once `hasCostData` is true (computed from
// Invoice.costAmount — a manually-entered field, see the Royalty Invoices
// edit form's "Cost" input). Otherwise shows `report.note` as an honest
// empty state instead of a fabricated $0.00/100% table, matching this app's
// established "never fabricate a financial figure" convention.
export function GrossMarginReportView({ report }: { report: GrossMarginReportSummary }) {
  const { metric, dimension } = splitGroupBy(report.groupBy);
  const metricLabel = METRIC_LABEL[metric];
  const range = `${dayjs(report.dateFrom).format('D MMM YYYY')} – ${dayjs(report.dateTo).format('D MMM YYYY')}`;
  const marginTone = report.marginPct >= 30 ? 'success' : report.marginPct >= 10 ? 'warning' : 'danger';

  const columns: ReportColumn<GrossMarginReportGroupRow>[] = [
    { key: 'label', label: dimension, value: (r) => r.groupLabel, render: (r) => <span className={styles.rowLabel}>{r.groupLabel}</span> },
    { key: 'cost', label: 'Total cost', numeric: true, value: (r) => r.totalCost, render: (r) => formatINR(r.totalCost) },
    { key: 'income', label: 'Total income', numeric: true, value: (r) => r.totalIncome, render: (r) => formatINR(r.totalIncome) },
    { key: 'margin', label: 'Gross margin', numeric: true, value: (r) => r.marginAmount, render: (r) => formatINR(r.marginAmount) },
    {
      key: 'marginPct',
      label: 'Margin %',
      numeric: true,
      value: (r) => r.marginPct,
      bar: (r) => r.marginPct,
      render: (r) => `${r.marginPct}%`,
    },
  ];

  return (
    <div className={styles.reportBody}>
      <div className={styles.reportIntro}>
        <div className={styles.reportTitle}>
          Gross margin — {metricLabel.toLowerCase()} per {dimension.toLowerCase()}
        </div>
        <div className={styles.reportDescription}>
          <FiCalendar aria-hidden /> {range} · What you earned versus what it cost.
        </div>
      </div>

      {!report.hasCostData ? (
        <EmptyState icon={FiPercent} title="No cost data yet" description={report.note} />
      ) : (
        <>
          <KpiRow
            items={[
              { label: 'Total income', value: formatINR(report.totalIncome), icon: FiTrendingUp, tone: 'success' },
              { label: 'Total cost', value: formatINR(report.totalCost), icon: FiShoppingCart },
              {
                label: 'Gross margin',
                value: formatINR(report.marginAmount),
                hint: `${report.marginPct}% of income`,
                icon: FiPercent,
                tone: marginTone,
              },
              {
                label: 'Invoice coverage',
                value: `${report.coveragePct}%`,
                hint: `${report.invoicesWithCost} of ${report.totalInvoicesInRange} invoices have a cost`,
                icon: FiCheckCircle,
                tone: report.coveragePct >= 80 ? 'success' : 'warning',
              },
            ]}
          />

          {report.note && (
            <div className={styles.note}>
              <FiInfo aria-hidden />
              <span>{report.note}</span>
            </div>
          )}

          <ReportTable
            columns={columns}
            rows={report.groups}
            rowKey={(r) => r.groupKey}
            defaultSort={{ key: 'margin', dir: 'desc' }}
            searchPlaceholder={`Search ${dimension.toLowerCase()}s`}
            filename={`gross-margin-${report.groupBy}-${report.dateFrom}-to-${report.dateTo}.csv`}
          />
        </>
      )}
    </div>
  );
}
