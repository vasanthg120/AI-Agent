import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { FiBriefcase, FiClock, FiDownload, FiGrid, FiList, FiPercent, FiZap } from 'react-icons/fi';
import { Badge, Button, DateRangeControl, Dropdown, SectionCard, Skeleton, StatTile, type DateRange } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import {
  royaltyReportService,
  type RoyaltyReportLineSummary,
  type RoyaltyReportSummary,
} from '@/services/royaltyReportService';
import styles from '../royalty.module.css';

// Shared "Summary: Total Records / Total Sales (Ex Tax)" footer under each
// itemized table — same two figures for Deals/Work In Progress, so this is
// one small component instead of two copies of the same markup.
function TableSummaryFooter({ summary }: { summary: RoyaltyReportLineSummary }) {
  return (
    <div className={styles.tableSummaryFooter}>
      <span className={styles.tableSummaryLabel}>Summary:</span>
      <span>
        {summary.totalRecords} record{summary.totalRecords === 1 ? '' : 's'}
      </span>
      <span className={styles.tableSummaryValue}>Total Sales (Ex Tax): {money(summary.totalSalesExTax)}</span>
    </div>
  );
}

type ViewMode = 'card' | 'table';

const DEAL_STATUS_VARIANT: Record<'open' | 'won' | 'lost', 'neutral' | 'success' | 'danger'> = {
  open: 'neutral',
  won: 'success',
  lost: 'danger',
};

interface ReportLine {
  label: string;
  value: string;
}

// Same content/order as backend/src/royalty/royalty-report-export.service.ts's
// buildRows — kept in sync deliberately, so the on-screen table and every
// downloaded export show the exact same Executive Summary line items.
function buildReportLines(report: RoyaltyReportSummary): ReportLine[] {
  const lines: ReportLine[] = [
    { label: 'Total Quotes', value: String(report.totalQuotes) },
    { label: 'Total Not Accepted Quotes', value: String(report.totalNotAcceptedQuotes) },
    { label: 'Total Deals', value: String(report.totalDeals) },
    { label: 'Total Invoices', value: String(report.totalInvoices) },
    { label: 'Total Void Invoices', value: String(report.totalVoidInvoices) },
    { label: 'Value of Currently Voided Invoices', value: money(report.valueOfVoidedInvoices) },
    { label: 'Value of Work In Progress', value: money(report.workInProgressValue) },
    { label: 'Gross Revenue', value: money(report.grossRevenue) },
    { label: 'Eligible Revenue', value: money(report.eligibleRevenue) },
    { label: 'Royalty Percentage', value: report.royaltyRule ? `${report.royaltyRule.royaltyPercentage}%` : '—' },
    { label: 'Royalty Fee (before cap)', value: money(report.royaltyFeeBeforeCap) },
    { label: 'Total Due', value: money(report.totalDue) },
    {
      label: 'Effective Royalty % (after cap)',
      value: report.effectiveRoyaltyPct !== null ? `${report.effectiveRoyaltyPct}%` : '—',
    },
  ];
  if (report.marketingFeeAmount !== null) lines.push({ label: 'Marketing Fee', value: money(report.marketingFeeAmount) });
  if (report.otherFeeAmount !== null) lines.push({ label: 'Other Fee', value: money(report.otherFeeAmount) });
  return lines;
}

// Explicit filter + Generate button, not an auto-refetching dashboard —
// picking a date range only updates local state; the report itself is only
// computed on a real click, matching the on-demand "Generate" idiom already
// established for Customer Activity's/Finance's own AI summaries (never
// fired automatically on mount or on every filter change). Computed
// entirely from real, already-existing CRM data (won-deal revenue plus any
// real invoices) — no manual invoice entry is required to see a report.
// DateRangeControl (not MonthPicker) — a real "start date through end
// date" range, not locked to a calendar month; its own "This Month" preset
// still covers the whole-month case.
export function RoyaltyReportSection() {
  const [range, setRange] = useState<DateRange>(() => ({
    dateFrom: dayjs().startOf('month').format('YYYY-MM-DD'),
    dateTo: dayjs().format('YYYY-MM-DD'),
  }));
  const [report, setReport] = useState<RoyaltyReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('table');

  const canGenerate = !!range.dateFrom && !!range.dateTo;

  const handleGenerate = async () => {
    if (!range.dateFrom || !range.dateTo) {
      setError('Choose a start date and an end date first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await royaltyReportService.generate(range.dateFrom, range.dateTo);
      setReport(result);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    if (!range.dateFrom || !range.dateTo) return;
    setExporting(true);
    try {
      await royaltyReportService.downloadExport(format, range.dateFrom, range.dateTo);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const lines = useMemo(() => (report ? buildReportLines(report) : []), [report]);
  const hasFees = report && (report.marketingFeeAmount !== null || report.otherFeeAmount !== null);

  return (
    <div className={styles.section}>
      <div className={styles.filterBar}>
        <div className={styles.filterRow}>
          <DateRangeControl value={range} onChange={setRange} />
          <Button type="button" loading={loading} disabled={!canGenerate} onClick={() => void handleGenerate()}>
            Generate
          </Button>
          {report && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leftIcon={view === 'table' ? <FiGrid /> : <FiList />}
                onClick={() => setView((v) => (v === 'table' ? 'card' : 'table'))}
              >
                {view === 'table' ? 'Card view' : 'Table view'}
              </Button>
              <Dropdown
                trigger={
                  <Button type="button" variant="ghost" size="sm" loading={exporting} leftIcon={<FiDownload />}>
                    Export
                  </Button>
                }
                items={[
                  { id: 'csv', label: 'Export as CSV', onSelect: () => void handleExport('csv') },
                  { id: 'xlsx', label: 'Export as Excel', onSelect: () => void handleExport('xlsx') },
                  { id: 'pdf', label: 'Export as PDF', onSelect: () => void handleExport('pdf') },
                ]}
              />
            </>
          )}
        </div>
      </div>

      {error && <div className={styles.emptyState}>{error}</div>}

      {loading && <Skeleton height={220} />}

      {!loading && report && (
        <>
          {!report.royaltyRule && (
            <div className={styles.emptyState}>
              No royalty rule is configured yet — set one under Settings → Royalty Rules for real Total
              Due/Royalty Fee figures.
            </div>
          )}
          <div className={styles.reportNote}>{report.dataSourceNote}</div>

          <SectionCard
            title={`Executive Summary — ${dayjs(report.dateFrom).format('MMM D, YYYY')} to ${dayjs(report.dateTo).format('MMM D, YYYY')}`}
            icon={FiZap}
          >
            {view === 'table' ? (
              <table className={clsx(styles.reportTable, styles.summaryTable)}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.label}>
                      <td>{line.label}</td>
                      <td>{line.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className={styles.statsGrid}>
                {lines.map((line) => (
                  <StatTile key={line.label} value={line.value} label={line.label} />
                ))}
              </div>
            )}
          </SectionCard>

          {hasFees && view === 'card' && (
            <SectionCard title="Additional Fees" icon={FiPercent}>
              <div className={styles.statsGrid}>
                {report.marketingFeeAmount !== null && <StatTile value={money(report.marketingFeeAmount)} label="Marketing Fee" />}
                {report.otherFeeAmount !== null && <StatTile value={money(report.otherFeeAmount)} label="Other Fee" />}
              </div>
            </SectionCard>
          )}

          <SectionCard title={`Deals (${report.deals.length})`} icon={FiBriefcase}>
            {report.deals.length === 0 ? (
              <div className={styles.emptyState}>No deals in this date range.</div>
            ) : (
              <>
                <div className={styles.tableScroll}>
                  <table className={styles.reportTable}>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Quote #</th>
                        <th>Status</th>
                        <th>Value</th>
                        <th>Closing Date</th>
                        <th>Created Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.deals.map((d) => (
                        <tr key={d.dealId}>
                          <td>{d.customerName}</td>
                          <td>{d.quoteNumber ?? '—'}</td>
                          <td>
                            <Badge variant={DEAL_STATUS_VARIANT[d.dealStatus]}>{d.dealStatus}</Badge>
                          </td>
                          <td>{money(d.value)}</td>
                          <td>{d.closingDate ?? '—'}</td>
                          <td>{d.createdDate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <TableSummaryFooter summary={report.dealsSummary} />
              </>
            )}
          </SectionCard>

          <SectionCard title={`Work In Progress — Quotes (${report.wipQuotes.length})`} icon={FiClock}>
            {report.wipQuotes.length === 0 ? (
              <div className={styles.emptyState}>No quotes still awaiting a decision in this date range.</div>
            ) : (
              <>
                <div className={styles.tableScroll}>
                  <table className={styles.reportTable}>
                    <thead>
                      <tr>
                        <th>Quote #</th>
                        <th>Customer</th>
                        <th>Created Date</th>
                        <th>Quote Total (Ex Tax)</th>
                        <th>Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.wipQuotes.map((q) => (
                        <tr key={q.quoteId}>
                          <td>{q.quoteNumber ?? '—'}</td>
                          <td>{q.customerName}</td>
                          <td>{q.createdDate}</td>
                          <td>{money(q.quoteTotalExTax)}</td>
                          <td>{q.tax !== null ? money(q.tax) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <TableSummaryFooter summary={report.wipQuotesSummary} />
              </>
            )}
          </SectionCard>
        </>
      )}

      {!loading && !report && !error && (
        <div className={styles.emptyState}>Pick a date range and hit Generate to see that range&apos;s royalty report.</div>
      )}
    </div>
  );
}
