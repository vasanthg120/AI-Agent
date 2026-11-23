import { memo, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FiTrendingUp } from 'react-icons/fi';
import { Badge, PageHeader, Tabs } from '@/components/ui';
import { DataTable, Pagination, StatusBadge, TableToolbar } from '@/components/board';
import type { DataTableColumn, RowHeight } from '@/components/board';
import { dealsService, type Deal, type DealFilters } from '@/services/dealsService';
import { quotesService, type ListQuotesFilters, type Quote } from '@/services/quotesService';
import { statusDefinitionsService } from '@/services/statusDefinitionsService';
import { exportRowsToCsv } from '@/utils/csvExport';
import { QUOTE_PAYMENT_LABEL, QUOTE_PAYMENT_VARIANT } from '../status';
import customerStyles from '../customers.module.css';

const PAGE_SIZE = 25;

// Hoops reference: Home / Sent / Not Accepted / Lost / Current Jobs / On Hold
// / Production Go / Pipeline / Accepted Not Paid. 'On Hold' and 'Production
// Go' are left out deliberately — neither Deal.dealStatus nor
// Quote.quoteStatus has a value for them; inventing one here would mean a
// tab that either always shows nothing or lies about what it's showing.
const TABS: { id: string; label: string; entity: 'quote' | 'deal' }[] = [
  { id: 'home', label: 'Home', entity: 'quote' },
  { id: 'pipeline', label: 'Pipeline', entity: 'deal' },
  { id: 'sent', label: 'Sent', entity: 'quote' },
  { id: 'not-accepted', label: 'Not Accepted', entity: 'quote' },
  { id: 'accepted-not-paid', label: 'Accepted Not Paid', entity: 'quote' },
  { id: 'current-jobs', label: 'Current Jobs', entity: 'deal' },
  { id: 'lost', label: 'LOST', entity: 'deal' },
];

const QUOTE_FILTERS_BY_TAB: Record<string, ListQuotesFilters> = {
  home: {},
  sent: { quoteStatus: 'sent' },
  'not-accepted': { clientApprovalStatus: 'not-approved' },
  'accepted-not-paid': { clientApprovalStatus: 'approved' },
};

const DEAL_FILTERS_BY_TAB: Record<string, DealFilters> = {
  pipeline: { dealStatus: ['open'] },
  'current-jobs': { dealStatus: ['won'] },
  lost: { dealStatus: ['lost'] },
};

const money = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

// Hoops-parity — the SalesBoard, in-page inside /customers (no standalone
// route). Quotes and Deals are different shapes, so each tab renders its
// own DataTable<Quote> or DataTable<Deal> rather than forcing one row type
// to cover both.
export const SalesBoardTab = memo(function SalesBoardTab({
  tabs,
  offstage,
  onOpenQuote,
}: {
  tabs: ReactNode;
  offstage: boolean;
  onOpenQuote: (quoteId: string) => void;
}) {
  const [subTab, setSubTab] = useState('home');
  const tabDef = TABS.find((t) => t.id === subTab) ?? TABS[0];
  const [page, setPage] = useState(1);
  const [rowHeight, setRowHeight] = useState<RowHeight>('comfortable');
  const [dealSearchInput, setDealSearchInput] = useState('');

  const changeSubTab = (id: string) => {
    setSubTab(id);
    setPage(1);
  };

  const dealStatusDefs = useQuery({
    queryKey: ['status-definitions', 'deal.dealStatus'],
    queryFn: () => statusDefinitionsService.list('deal.dealStatus'),
  });
  const quoteApprovalDefs = useQuery({
    queryKey: ['status-definitions', 'quote.clientApprovalStatus'],
    queryFn: () => statusDefinitionsService.list('quote.clientApprovalStatus'),
  });
  const quoteStatusDefs = useQuery({
    queryKey: ['status-definitions', 'quote.quoteStatus'],
    queryFn: () => statusDefinitionsService.list('quote.quoteStatus'),
  });

  const quoteFilters = QUOTE_FILTERS_BY_TAB[tabDef.id];
  const dealFilters = DEAL_FILTERS_BY_TAB[tabDef.id];

  const quotesQuery = useQuery({
    queryKey: ['sales-board', 'quotes', tabDef.id, page],
    queryFn: () => quotesService.listFiltered(quoteFilters ?? {}, page, PAGE_SIZE),
    enabled: tabDef.entity === 'quote' && !offstage,
    placeholderData: keepPreviousData,
  });

  const dealsQuery = useQuery({
    queryKey: ['sales-board', 'deals', tabDef.id, page, dealSearchInput],
    queryFn: () => dealsService.listFiltered({ ...dealFilters, search: dealSearchInput || undefined }, page, PAGE_SIZE),
    enabled: tabDef.entity === 'deal' && !offstage,
    placeholderData: keepPreviousData,
  });

  const quoteColumns: DataTableColumn<Quote>[] = useMemo(
    () => [
      { key: 'quoteNumber', header: 'Quote #', alwaysVisible: true, render: (q) => <strong>{q.quoteNumber ?? '—'}</strong> },
      { key: 'client', header: 'Client', render: (q) => q.clientDetails?.companyName ?? q.quoteName ?? '—' },
      {
        key: 'quoteStatus',
        header: 'Status',
        render: (q) => <StatusBadge status={q.quoteStatus} definitions={quoteStatusDefs.data} />,
      },
      {
        key: 'clientApprovalStatus',
        header: 'Approval',
        render: (q) => <StatusBadge status={q.clientApprovalStatus} definitions={quoteApprovalDefs.data} />,
      },
      { key: 'amount', header: 'Amount', align: 'right', render: (q) => money(q.quoteAmount, q.currency) },
      {
        key: 'outstanding',
        header: 'Outstanding',
        align: 'right',
        // The reconciled outstanding when a reconciliation has run (so a Square payment shows even if Hoops still says Not Paid).
        render: (q) => money(q.paymentReconciliation ? q.paymentReconciliation.outstandingAmount : Math.max(q.quoteAmount - q.paidAmount, 0), q.currency),
      },
      {
        key: 'reconciledPayment',
        header: 'Payment',
        render: (q) => {
          const p = q.paymentReconciliation;
          if (!p) return '—';
          return (
            <span title={p.crmOutdated ? 'The CRM still shows less than what was actually paid' : p.crmUnverified ? 'Reported by the CRM — no matching transaction found' : undefined}>
              <Badge variant={QUOTE_PAYMENT_VARIANT[p.status]}>{QUOTE_PAYMENT_LABEL[p.status]}</Badge>
              {p.sources.length > 0 && <small> {p.sources.map((s) => (s.verified ? s.name : `${s.name} (reported)`)).join(', ')}</small>}
            </span>
          );
        },
      },
      { key: 'createdAt', header: 'Created', render: (q) => new Date(q.createdAt).toLocaleDateString() },
    ],
    [quoteStatusDefs.data, quoteApprovalDefs.data],
  );

  const dealColumns: DataTableColumn<Deal>[] = useMemo(
    () => [
      { key: 'name', header: 'Deal', alwaysVisible: true, render: (d) => <strong>{d.name}</strong> },
      { key: 'owner', header: 'Owner', render: (d) => d.externalOwnerLabel ?? d.ownerId ?? '—' },
      { key: 'dealStatus', header: 'Status', render: (d) => <StatusBadge status={d.dealStatus} definitions={dealStatusDefs.data} /> },
      { key: 'value', header: 'Value', align: 'right', render: (d) => d.monetaryValue.toLocaleString() },
      { key: 'closing', header: 'Expected close', render: (d) => d.expectedClosingDate ?? '—' },
      ...(tabDef.id === 'lost'
        ? [{ key: 'lostReason', header: 'Lost reason', render: (d: Deal) => d.lostReason ?? '—' } as DataTableColumn<Deal>]
        : []),
    ],
    [dealStatusDefs.data, tabDef.id],
  );

  const handleExportQuotes = () => {
    if (!quotesQuery.data) return;
    exportRowsToCsv(
      [
        { header: 'Quote #', value: (q: Quote) => q.quoteNumber ?? '' },
        { header: 'Client', value: (q: Quote) => q.clientDetails?.companyName ?? q.quoteName ?? '' },
        { header: 'Status', value: (q: Quote) => q.quoteStatus },
        { header: 'Approval', value: (q: Quote) => q.clientApprovalStatus },
        { header: 'Amount', value: (q: Quote) => q.quoteAmount },
        { header: 'Outstanding', value: (q: Quote) => (q.paymentReconciliation ? q.paymentReconciliation.outstandingAmount : Math.max(q.quoteAmount - q.paidAmount, 0)) },
        { header: 'Payment', value: (q: Quote) => (q.paymentReconciliation ? QUOTE_PAYMENT_LABEL[q.paymentReconciliation.status] : '') },
        { header: 'Payment source', value: (q: Quote) => q.paymentReconciliation?.sources.map((s) => s.name).join(', ') ?? '' },
        { header: 'Created', value: (q: Quote) => new Date(q.createdAt).toLocaleDateString() },
      ],
      quotesQuery.data.items,
      `salesboard-${tabDef.id}-page${page}.csv`,
    );
  };

  const handleExportDeals = () => {
    if (!dealsQuery.data) return;
    exportRowsToCsv(
      [
        { header: 'Deal', value: (d: Deal) => d.name },
        { header: 'Owner', value: (d: Deal) => d.externalOwnerLabel ?? d.ownerId ?? '' },
        { header: 'Status', value: (d: Deal) => d.dealStatus },
        { header: 'Value', value: (d: Deal) => d.monetaryValue },
        { header: 'Expected close', value: (d: Deal) => d.expectedClosingDate ?? '' },
      ],
      dealsQuery.data.items,
      `salesboard-${tabDef.id}-page${page}.csv`,
    );
  };

  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader icon={FiTrendingUp} title="SalesBoard" subtitle="Every deal and quote, grouped by where it stands." />

      <Tabs items={TABS.map((t) => ({ id: t.id, label: t.label }))} activeId={tabDef.id} onChange={changeSubTab} />

      {tabDef.entity === 'quote' ? (
        <>
          <TableToolbar rowHeight={rowHeight} onRowHeightChange={setRowHeight} onExport={handleExportQuotes} />
          <DataTable
            columns={quoteColumns}
            rows={quotesQuery.data?.items ?? []}
            rowKey={(row) => row._id}
            rowHeight={rowHeight}
            loading={quotesQuery.isLoading}
            busy={quotesQuery.isFetching}
            onRowClick={(row) => onOpenQuote(row._id)}
            emptyState={<p className={customerStyles.none}>Nothing in this view yet.</p>}
          />
          {quotesQuery.data && (
            <Pagination
              page={quotesQuery.data.page}
              pageSize={quotesQuery.data.pageSize}
              total={quotesQuery.data.total}
              itemLabel="quotes"
              onPageChange={setPage}
            />
          )}
        </>
      ) : (
        <>
          <TableToolbar
            searchValue={dealSearchInput}
            onSearchChange={(v) => {
              setDealSearchInput(v);
              setPage(1);
            }}
            searchPlaceholder="Search deal name"
            rowHeight={rowHeight}
            onRowHeightChange={setRowHeight}
            onExport={handleExportDeals}
          />
          <DataTable
            columns={dealColumns}
            rows={dealsQuery.data?.items ?? []}
            rowKey={(row) => row._id}
            rowHeight={rowHeight}
            loading={dealsQuery.isLoading}
            busy={dealsQuery.isFetching}
            emptyState={<p className={customerStyles.none}>Nothing in this view yet.</p>}
          />
          {dealsQuery.data && (
            <Pagination
              page={dealsQuery.data.page}
              pageSize={dealsQuery.data.pageSize}
              total={dealsQuery.data.total}
              itemLabel="deals"
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </div>
  );
});
