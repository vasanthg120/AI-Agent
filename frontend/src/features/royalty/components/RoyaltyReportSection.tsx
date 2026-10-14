import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { FiDownload, FiFileText, FiGrid, FiList, FiPercent, FiZap } from 'react-icons/fi';
import {
  Badge,
  Button,
  DateRangeControl,
  Dropdown,
  SectionCard,
  Skeleton,
  StatTile,
  type DateRange,
} from '@/components/ui';
import { formatINRExact as money } from '@/utils/currency';
import { dayjs } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import {
  royaltyReportService,
  type RoyaltyReportQuotationsSummary,
  type RoyaltyReportSummary,
} from '@/services/royaltyReportService';
import styles from '../royalty.module.css';

// Under the quotations: how many, and what they add up to — excluding tax, tax, including tax, royalty.
function TableSummaryFooter({ summary }: { summary: RoyaltyReportQuotationsSummary }) {
  return (
    <div className={styles.tableSummaryFooter}>
      <span className={styles.tableSummaryLabel}>Summary:</span>
      <span>
        {summary.totalRecords} quotation{summary.totalRecords === 1 ? '' : 's'}
      </span>
      <span className={styles.tableSummaryValue}>Sales (Ex Tax): {money(summary.totalSalesExTax)}</span>
      <span>Tax: {money(summary.totalTax)}</span>
      <span>Sales (Inc Tax): {money(summary.totalSalesIncTax)}</span>
      <span>Royalty: {money(summary.totalRoyalty)}</span>
    </div>
  );
}

type ViewMode = 'card' | 'table';

interface ReportLine {
  label: string;
  value: string;
}

// Same content/order as backend/src/royalty/royalty-report-export.service.ts's
// buildRows — kept in sync deliberately, so the on-screen table and every
// downloaded export show the exact same Executive Summary line items.
function buildReportLines(report: RoyaltyReportSummary): ReportLine[] {
  const lines: ReportLine[] = [
    { label: 'Quotations Sent', value: String(report.totalQuotes) },
    { label: 'Accepted Quotations', value: String(report.totalAcceptedQuotes) },
    { label: 'Not Accepted Yet', value: String(report.totalNotAcceptedQuotes) },
    { label: 'Sales (Ex Tax)', value: money(report.salesExTax) },
    { label: 'Tax', value: money(report.tax) },
    { label: 'Sales (Including Tax)', value: money(report.salesIncTax) },
    {
      label: 'Royalty Charged On',
      value: report.royaltyBase === 'exTax' ? 'Sales (Ex Tax)' : 'Sales (Including Tax)',
    },
    { label: 'Royalty Percentage', value: report.royaltyRule ? `${report.royaltyRule.royaltyPercentage}%` : '—' },
    { label: 'Royalty Fee (before cap)', value: money(report.royaltyFeeBeforeCap) },
    { label: 'Total Due', value: money(report.totalDue) },
    {
      label: 'Effective Royalty % (after cap)',
      value: report.effectiveRoyaltyPct !== null ? `${report.effectiveRoyaltyPct}%` : '—',
    },
  ];
  if (report.marketingFeeAmount !== null)
    lines.push({ label: 'Marketing Fee', value: money(report.marketingFeeAmount) });
  if (report.otherFeeAmount !== null) lines.push({ label: 'Other Fee', value: money(report.otherFeeAmount) });
  return lines;
}

// Explicit filter + Generate button, not an auto-refetching dashboard —
// picking a date range only updates local state; the report itself is only
// computed on a real click, matching the on-demand "Generate" idiom already
// established for Customer Activity's/Finance's own AI summaries (never
// fired automatically on mount or on every filter change). Worked out from
// the quotations sent in the period — the value and the tax each quotation
// carries — the same ones the Sales and Gross Margin reports count.
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
              No royalty rule is configured yet — set one under Settings → Royalty Rules for real Total Due/Royalty Fee
              figures.
            </div>
          )}
          <div className={styles.reportNote}>{report.dataSourceNote}</div>

          <SectionCard
            title={`Executive Summary — ${dayjs(report.dateFrom).format('MMM D, YYYY')} to ${dayjs(report.dateTo).format('MMM D, YYYY')}`}
            icon={FiZap}
          >
            {view === 'table' ? (
              <div className={styles.tableScroll}>
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
              </div>
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
                {report.marketingFeeAmount !== null && (
                  <StatTile value={money(report.marketingFeeAmount)} label="Marketing Fee" />
                )}
                {report.otherFeeAmount !== null && <StatTile value={money(report.otherFeeAmount)} label="Other Fee" />}
              </div>
            </SectionCard>
          )}

          <SectionCard title={`Quotations (${report.quotations.length})`} icon={FiFileText}>
            {report.quotations.length === 0 ? (
              <div className={styles.emptyState}>No quotation was sent in this date range.</div>
            ) : (
              <>
                <div className={styles.tableScroll}>
                  <table className={clsx(styles.reportTable, styles.linesTable)}>
                    <thead>
                      <tr>
                        <th>Quote #</th>
                        <th>Customer</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th className={styles.num}>Sales (Ex Tax)</th>
                        <th className={styles.num}>Tax</th>
                        <th className={styles.num}>Sales (Inc Tax)</th>
                        <th className={styles.num}>Royalty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.quotations.map((q) => (
                        <tr key={q.quoteId}>
                          <td data-label="Quote #">{q.quoteNumber ?? '—'}</td>
                          <td data-label="Customer">{q.customerName}</td>
                          <td data-label="Date">{dayjs(q.date).format('D MMM YYYY')}</td>
                          <td data-label="Status">
                            <Badge variant={q.accepted ? 'success' : 'neutral'}>
                              {q.accepted ? 'Accepted' : 'Not accepted yet'}
                            </Badge>
                          </td>
                          <td data-label="Sales (Ex Tax)" className={styles.num}>
                            {money(q.salesExTax)}
                          </td>
                          <td data-label="Tax" className={styles.num}>
                            {money(q.tax)}
                          </td>
                          <td data-label="Sales (Inc Tax)" className={styles.num}>
                            {money(q.salesIncTax)}
                          </td>
                          <td data-label="Royalty" className={styles.num}>
                            {report.royaltyRule ? money(q.royalty) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <TableSummaryFooter summary={report.quotationsSummary} />
              </>
            )}
          </SectionCard>
        </>
      )}

      {!loading && !report && !error && (
        <div className={styles.emptyState}>
          Pick a date range and hit Generate to see that range&apos;s royalty report.
        </div>
      )}
    </div>
  );
}
