import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';
import { FiTrendingUp, FiPackage, FiArrowUpRight, FiTarget, FiZap, FiHelpCircle, FiDownload, FiSearch } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { AnimatedNumber, Badge, Card, EmptyState, Skeleton } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR as money } from '@/utils/currency';
import {
  vendorProfitabilityService,
  type VendorCustomerCompareResult,
  type VendorProfitabilityTransactionRow,
} from '@/services/vendorProfitabilityService';
import { financeDocumentsService } from '@/services/financeDocumentsService';
import { ROUTES } from '@/constants/routes';
import biStyles from '@/features/business-intelligence/business-intelligence.module.css';
import styles from '../analytics-dashboard.module.css';
import statStyles from './VendorProfitabilityStats.module.css';
import panelStyles from './VendorProfitabilityPanel.module.css';

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid',
  partially_paid: 'Partially paid',
  pending: 'Pending',
  overdue: 'Overdue',
};

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'paid') return 'success';
  if (status === 'partially_paid') return 'warning';
  if (status === 'overdue') return 'danger';
  return 'neutral';
}

type SortMode = 'newest' | 'profit' | 'margin';
const SORT_LABEL: Record<SortMode, string> = { newest: 'Newest', profit: 'Highest profit', margin: 'Lowest margin' };

// Green healthy, amber thin, red losing money — so a problem row jumps out
// of a 12-column table without reading every number.
function marginClass(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  if (pct >= 20) return panelStyles.marginGood;
  if (pct >= 5) return panelStyles.marginOk;
  return panelStyles.marginBad;
}

function sortRows(rows: VendorProfitabilityTransactionRow[], mode: SortMode) {
  const sorted = [...rows];
  if (mode === 'profit') sorted.sort((a, b) => (b.profitAmount ?? -Infinity) - (a.profitAmount ?? -Infinity));
  else if (mode === 'margin') sorted.sort((a, b) => (a.profitMarginPct ?? Infinity) - (b.profitMarginPct ?? Infinity));
  else sorted.sort((a, b) => (b.quoteDate ?? b.invoiceDate ?? '').localeCompare(a.quoteDate ?? a.invoiceDate ?? ''));
  return sorted;
}

function StatCard({
  icon: Icon,
  label,
  value,
  note,
  onClick,
}: {
  icon: IconType;
  label: string;
  value: ReactNode;
  note: string;
  onClick?: () => void;
}) {
  return (
    <Card className={statStyles.cell} interactive={!!onClick} onClick={onClick}>
      <span className={statStyles.iconBadge}>
        <Icon size={16} />
      </span>
      <div className={statStyles.label}>{label}</div>
      <div className={statStyles.value}>{value}</div>
      <div className={statStyles.note}>{note}</div>
    </Card>
  );
}

// Business Intelligence section 5 — Accounts Receivable & Vendor
// Profitability. This tab is only rendered for owner/admin (see
// AnalyticsDashboardPage's own tab-visibility filter) — margin data is more
// sensitive than pipeline data.
//
// One row per linked Customer Quote <-> Vendor Invoice transaction (see
// vendor-profitability.service.ts's getTransactions) — deliberately NOT
// aggregated by Deal the way the older getOverview()/VendorProfitabilityRow
// path is, since a customer quote with no Deal (common — Deal is optional on
// Quote) would otherwise never show up here even after being linked
// correctly via Finance AI's "Customer Quote No" field
// (FinanceDocumentReviewModal.tsx). Profit is always Customer Quote Amount
// minus Vendor Invoice Amount, read live from the linked Quote/FinanceDocument
// — never a manually-entered figure.
export function VendorProfitabilitySection({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const navigate = useNavigate();
  const [aiResult, setAiResult] = useState<VendorCustomerCompareResult | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const filters = { dateFrom, dateTo };

  const { data, isLoading } = useQuery({
    queryKey: ['dash-vendor-profitability-transactions', filters],
    queryFn: () => vendorProfitabilityService.getTransactions(filters),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // AI Compare is still the older deal-based comparison (its python-agent
  // payload/response shape is dealId-keyed) — fetched independently here,
  // decoupled from the transaction table above, purely to resolve a
  // human-readable deal name for the narrative below. Cheap and cached; the
  // button itself only appears once there's at least one transaction row.
  const { data: dealOverview } = useQuery({
    queryKey: ['dash-vendor-profitability', filters],
    queryFn: () => vendorProfitabilityService.getOverview(filters),
    enabled: !!data && data.rows.length > 0,
    staleTime: 30_000,
  });

  const aiCompare = useMutation({
    mutationFn: () => vendorProfitabilityService.requestAiComparison(filters),
    onSuccess: (result) => setAiResult(result),
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const hasRows = !!data && data.rows.length > 0;

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (data?.rows ?? []).filter(
      (r) =>
        !q ||
        [r.customerName, r.vendorName, r.customerQuoteNo, r.vendorInvoiceNumber].some((f) => f?.toLowerCase().includes(q)),
    );
    return sortRows(rows, sortMode);
  }, [data, query, sortMode]);

  const handleViewInvoice = async (transactionId: string) => {
    setViewingId(transactionId);
    try {
      await financeDocumentsService.viewFile(transactionId);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setViewingId(null);
    }
  };

  return (
    <div className={styles.tabContent}>
      {data && data.currencyMismatchCount > 0 && (
        <div className={biStyles.coverageNote}>
          {data.currencyMismatchCount} transaction(s) have mismatched currencies — flagged below and excluded from totals.
        </div>
      )}

      {isLoading || !data ? (
        <Skeleton height={100} />
      ) : (
        <div className={statStyles.grid}>
          <StatCard
            icon={FiTrendingUp}
            label="Customer quoted"
            value={<AnimatedNumber value={data.totals.customerQuoteAmount} format={money} />}
            note={data.totals.customerQuoteAmount > 0 ? 'in this period' : 'no linked transactions'}
          />
          <StatCard
            icon={FiPackage}
            label="Vendor invoiced"
            value={<AnimatedNumber value={data.totals.vendorInvoiceAmount} format={money} />}
            note={hasRows ? 'in this period' : 'awaiting linked invoices'}
          />
          <StatCard
            icon={FiArrowUpRight}
            label="Profit"
            value={<AnimatedNumber value={data.totals.profitAmount} format={money} />}
            note={hasRows ? 'quote minus invoice' : 'awaiting linked invoices'}
          />
          <StatCard
            icon={FiTarget}
            label="Profit margin"
            value={
              data.totals.profitMarginPct !== null ? (
                <span className={marginClass(data.totals.profitMarginPct)}>{data.totals.profitMarginPct}%</span>
              ) : (
                '—'
              )
            }
            note={data.totals.profitMarginPct !== null ? 'of customer quote amount' : 'not enough data'}
          />
        </div>
      )}

      <Card className={panelStyles.card}>
        <div className={panelStyles.header}>
          <div className={panelStyles.headerText}>
            <div className={panelStyles.label}>Cost Intelligence</div>
            <div className={panelStyles.title}>Vendor profitability</div>
            <p className={panelStyles.subtitle}>How much we quoted the customer, how much we paid the vendor, and the resulting profit — per transaction.</p>
          </div>
          {hasRows && (
            <div className={panelStyles.headerActions}>
              <button type="button" className={panelStyles.aiBtn} disabled={aiCompare.isPending} onClick={() => aiCompare.mutate()}>
                <FiZap size={13} />
                {aiCompare.isPending ? 'Comparing…' : 'AI Compare'}
              </button>
            </div>
          )}
        </div>

        <div className={panelStyles.divider} />

        {isLoading || !data ? (
          <Skeleton height={140} />
        ) : !hasRows ? (
          <div className={panelStyles.emptyState}>
            <span className={panelStyles.emptyIconBadge}>
              <FiPackage size={20} />
            </span>
            <div className={panelStyles.emptyBody}>
              <div className={panelStyles.emptyTitle}>Nothing to compare yet</div>
              <p className={panelStyles.emptySubtitle}>
                Link a vendor invoice to a customer quote via Finance AI's "Customer Quote No" field to see it here.
              </p>
            </div>
            <button type="button" className={panelStyles.learnBtn} onClick={() => navigate(ROUTES.finance)}>
              Go to Finance AI
              <FiHelpCircle size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className={panelStyles.tableToolbar}>
              <label className={panelStyles.tableSearch}>
                <FiSearch aria-hidden />
                <input value={query} placeholder="Search customer, vendor or number" onChange={(e) => setQuery(e.target.value)} />
              </label>
              <div className={panelStyles.sortGroup} role="radiogroup" aria-label="Sort transactions">
                {(Object.keys(SORT_LABEL) as SortMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={sortMode === m}
                    className={clsx(panelStyles.sortButton, sortMode === m && panelStyles.sortButtonActive)}
                    onClick={() => setSortMode(m)}
                  >
                    {SORT_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
            {visibleRows.length === 0 ? (
              <EmptyState compact icon={FiSearch} title="No transactions match that search" />
            ) : (
              <div className={panelStyles.tableWrap}>
                <table className={panelStyles.table}>
                  <thead>
                    <tr>
                      <th>Customer Name</th>
                      <th>Customer Quote No</th>
                      <th>Customer Quote Amount</th>
                      <th>Vendor Name</th>
                      <th>Vendor Invoice No</th>
                      <th>Vendor Invoice Amount</th>
                      <th>Profit</th>
                      <th>Profit Margin</th>
                      <th>Quote Date</th>
                      <th>Invoice Date</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => (
                      <motion.tr
                        key={r.transactionId}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.02 }}
                      >
                        <td className={panelStyles.dealCell}>{r.customerName ?? '—'}</td>
                        <td>{r.customerQuoteNo ?? '—'}</td>
                        <td>
                          {money(r.customerQuoteAmount)} {r.quoteCurrency !== 'INR' ? r.quoteCurrency : ''}
                        </td>
                        <td>{r.vendorName ?? '—'}</td>
                        <td>{r.vendorInvoiceNumber ?? '—'}</td>
                        <td>
                          {money(r.vendorInvoiceAmount)} {r.vendorCurrency !== 'INR' ? r.vendorCurrency : ''}
                        </td>
                        <td className={r.profitAmount !== null && r.profitAmount < 0 ? panelStyles.loss : undefined}>
                          {r.currencyMismatch ? <Badge variant="warning">Currency mismatch</Badge> : money(r.profitAmount ?? 0)}
                        </td>
                        <td>
                          {r.profitMarginPct !== null ? (
                            <span className={clsx(panelStyles.marginChip, marginClass(r.profitMarginPct))}>{r.profitMarginPct}%</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{r.quoteDate ? dayjs(r.quoteDate).format('YYYY-MM-DD') : '—'}</td>
                        <td>{r.invoiceDate ?? '—'}</td>
                        <td>
                          <Badge variant={statusVariant(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={panelStyles.learnBtn}
                            disabled={viewingId === r.transactionId}
                            onClick={() => void handleViewInvoice(r.transactionId)}
                          >
                            <FiDownload size={13} />
                            {viewingId === r.transactionId ? 'Opening…' : 'View Invoice'}
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      {aiResult && (
        <motion.div
          className={biStyles.aiSummaryCard}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className={biStyles.aiInsightLabel}>
            <FiZap size={14} /> AI Pricing Comparison
          </span>
          <span className={biStyles.aiInsightText}>{aiResult.aggregateNarrative}</span>
          {aiResult.flaggedTransactions.length > 0 && (
            <div className={biStyles.section}>
              <span className={biStyles.sectionTitle}>Flagged for Review</span>
              {aiResult.flaggedTransactions.map((f) => (
                <div key={f.dealId} className={biStyles.listItem}>
                  <div className={biStyles.listItemMain}>
                    <span className={biStyles.listItemTitle}>
                      {dealOverview?.rows.find((r) => r.dealId === f.dealId)?.dealName ?? f.dealId}
                    </span>
                    <span className={biStyles.listItemMeta}>{f.reason}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {aiResult.transactionNotes.length > 0 && (
            <div className={biStyles.section}>
              <span className={biStyles.sectionTitle}>Transaction Notes</span>
              {aiResult.transactionNotes.map((n) => (
                <div key={n.dealId} className={biStyles.listItem}>
                  <div className={biStyles.listItemMain}>
                    <span className={biStyles.listItemTitle}>
                      {dealOverview?.rows.find((r) => r.dealId === n.dealId)?.dealName ?? n.dealId}
                    </span>
                    <span className={biStyles.listItemMeta}>{n.commentary}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
