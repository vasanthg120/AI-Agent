import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiTrendingUp, FiPackage, FiArrowUpRight, FiTarget, FiZap, FiHelpCircle } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { Badge, Card, Skeleton } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { formatINR as money } from '@/utils/currency';
import { vendorProfitabilityService, type VendorCustomerCompareResult } from '@/services/vendorProfitabilityService';
import { ROUTES } from '@/constants/routes';
import biStyles from '@/features/business-intelligence/business-intelligence.module.css';
import { DrillDownModal, type DrillDownRow } from './DrillDownModal';
import styles from '../analytics-dashboard.module.css';
import statStyles from './VendorProfitabilityStats.module.css';
import panelStyles from './VendorProfitabilityPanel.module.css';

function StatCard({
  icon: Icon,
  label,
  value,
  note,
  onClick,
}: {
  icon: IconType;
  label: string;
  value: string;
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
// sensitive than pipeline data. No Net Profit column — Gross Profit only.
//
// "Vendor cost" here is driven by a paid/partially-paid FinanceDocument
// linked to a deal (see vendor-profitability.service.ts) — VendorQuote
// records only ever supply the vendor's display name, they don't drive the
// cost total. There is no frontend surface anywhere yet for manually
// linking a finance document to a deal (that linkage is set up during
// document processing) — so "Go to vendor quotes"/"Learn how" below point
// at the real Finance AI page (where those paid vendor documents actually
// live), not an invented quote-creation flow that wouldn't move these
// numbers.
export function VendorProfitabilitySection({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const navigate = useNavigate();
  const [aiResult, setAiResult] = useState<VendorCustomerCompareResult | null>(null);
  const filters = { dateFrom, dateTo };

  const { data, isLoading } = useQuery({
    queryKey: ['dash-vendor-profitability', filters],
    queryFn: () => vendorProfitabilityService.getOverview(filters),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const aiCompare = useMutation({
    mutationFn: () => vendorProfitabilityService.requestAiComparison(filters),
    onSuccess: (result) => setAiResult(result),
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const hasRows = !!data && data.rows.length > 0;
  const [showRows, setShowRows] = useState(false);
  const dealRows: DrillDownRow[] = (data?.rows ?? []).map((r) => ({
    id: r.dealId,
    title: r.dealName ?? r.dealId,
    subtitle: r.vendorNames.join(', ') || undefined,
    meta: r.currencyMismatch ? 'Currency mismatch' : r.grossMarginPct !== null ? `${r.grossMarginPct}% margin` : undefined,
    value: r.currencyMismatch ? undefined : (r.grossProfit ?? 0),
  }));

  return (
    <div className={styles.tabContent}>
      {data && data.coveragePct !== null && data.coveragePct < 100 && (
        <div className={biStyles.coverageNote}>
          {data.coveragePct}% of deals with a vendor invoice in this range have that cost fully/partially paid.
        </div>
      )}
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
            label="Customer revenue"
            value={money(data.totals.customerRevenue)}
            note={data.totals.customerRevenue > 0 ? 'in this period' : 'no linked transactions'}
            onClick={() => setShowRows(true)}
          />
          <StatCard
            icon={FiPackage}
            label="Vendor cost paid"
            value={money(data.totals.vendorCost)}
            note="in this period"
            onClick={() => setShowRows(true)}
          />
          <StatCard
            icon={FiArrowUpRight}
            label="Gross profit"
            value={money(data.totals.grossProfit)}
            note={hasRows ? 'in this period' : 'awaiting linked costs'}
            onClick={() => setShowRows(true)}
          />
          <StatCard
            icon={FiTarget}
            label="Gross margin"
            value={data.totals.grossMarginPct !== null ? `${data.totals.grossMarginPct}%` : '—'}
            note={data.totals.grossMarginPct !== null ? 'of customer revenue' : 'not enough data'}
            onClick={() => setShowRows(true)}
          />
        </div>
      )}

      <Card className={panelStyles.card}>
        <div className={panelStyles.header}>
          <div className={panelStyles.headerText}>
            <div className={panelStyles.label}>Cost Intelligence</div>
            <div className={panelStyles.title}>Vendor profitability</div>
            <p className={panelStyles.subtitle}>Connect vendor quotes and payments to understand margin by deal.</p>
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
              <p className={panelStyles.emptySubtitle}>Transactions with a linked, paid vendor cost will show up here automatically.</p>
            </div>
            <button type="button" className={panelStyles.learnBtn} onClick={() => navigate(ROUTES.finance)}>
              Learn how
              <FiHelpCircle size={14} />
            </button>
          </div>
        ) : (
          <div className={panelStyles.tableWrap}>
            <table className={panelStyles.table}>
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Vendor(s)</th>
                  <th>Vendor Cost</th>
                  <th>Customer Revenue</th>
                  <th>Customer Paid</th>
                  <th>Gross Profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.dealId}>
                    <td className={panelStyles.dealCell}>{r.dealName ?? r.dealId}</td>
                    <td>{r.vendorNames.join(', ') || '—'}</td>
                    <td>
                      {money(r.vendorCost)} {r.vendorCostCurrency !== 'INR' ? r.vendorCostCurrency : ''}
                    </td>
                    <td>
                      {money(r.customerRevenue)} {r.customerRevenueCurrency !== 'INR' ? r.customerRevenueCurrency : ''}
                    </td>
                    <td>{money(r.customerPaid)}</td>
                    <td>{r.currencyMismatch ? <Badge variant="warning">Currency mismatch</Badge> : money(r.grossProfit ?? 0)}</td>
                    <td>{r.grossMarginPct !== null ? `${r.grossMarginPct}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!isLoading && data && !hasRows && (
        <Card className={clsx(panelStyles.card, panelStyles.nextStepCard)}>
          <div className={panelStyles.nextStepText}>
            <div className={panelStyles.label}>Recommended Next Step</div>
            <div className={panelStyles.title}>Link vendor costs to deals</div>
            <p className={panelStyles.nextStepBody}>
              Once a paid vendor invoice is linked to a deal, HaiVE can surface gross profit and margin changes in this view.
            </p>
          </div>
          <div className={panelStyles.nextStepAction}>
            <span className={panelStyles.stepNumber}>01</span>
            <button type="button" className={panelStyles.nextStepLink} onClick={() => navigate(ROUTES.finance)}>
              Go to Finance AI
              <FiArrowUpRight size={14} />
            </button>
          </div>
        </Card>
      )}

      {aiResult && (
        <div className={biStyles.aiSummaryCard}>
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
                    <span className={biStyles.listItemTitle}>{data?.rows.find((r) => r.dealId === f.dealId)?.dealName ?? f.dealId}</span>
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
                    <span className={biStyles.listItemTitle}>{data?.rows.find((r) => r.dealId === n.dealId)?.dealName ?? n.dealId}</span>
                    <span className={biStyles.listItemMeta}>{n.commentary}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <DrillDownModal open={showRows} onClose={() => setShowRows(false)} title="Vendor Profitability by Deal" isLoading={isLoading} rows={dealRows} />
    </div>
  );
}
