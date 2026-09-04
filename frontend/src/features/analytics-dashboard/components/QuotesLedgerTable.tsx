import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { FiSearch, FiChevronDown, FiDownload, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import { Card, Input } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { quotesService, type Quote } from '@/services/quotesService';
import styles from './QuotesLedgerTable.module.css';

type StatusFilter = 'all' | 'approved' | 'awaiting' | 'rejected';

const PAGE_SIZE = 7;

function statusOf(q: Quote): 'approved' | 'rejected' | 'awaiting' {
  const s = q.clientApprovalStatus?.toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  return 'awaiting';
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface QuotesLedgerTableProps {
  dateFrom: string;
  dateTo: string;
}

// A complete ledger of every quote in the period — not just the ones tied to
// still-open deals (see DealsNeedingDecisionTable, which is scoped to
// actionable/undecided ones). Status buckets only Approved/Rejected when
// Quote.clientApprovalStatus literally says so; everything else (including
// the schema's own 'pending' default) falls into Awaiting — no status is
// invented. Outstanding = quoteAmount - paidAmount, both real fields.
export function QuotesLedgerTable({ dateFrom, dateTo }: QuotesLedgerTableProps) {
  const { data: quotesResult } = useQuery({
    queryKey: ['analytics-quotes-ledger', dateFrom, dateTo],
    queryFn: () => quotesService.listFiltered({ dateFrom, dateTo }, 1, 100),
  });

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const quotes = quotesResult?.items ?? [];

  const filtered = useMemo(() => {
    let list = quotes;
    if (statusFilter !== 'all') list = list.filter((q) => statusOf(q) === statusFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (item) =>
          (item.quoteNumber ?? '').toLowerCase().includes(q) ||
          (item.clientDetails?.companyName ?? '').toLowerCase().includes(q) ||
          (item.quoteName ?? '').toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => (sortDesc ? b.quoteAmount - a.quoteAmount : a.quoteAmount - b.quoteAmount));
  }, [quotes, statusFilter, query, sortDesc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const handleExport = () => {
    const header = ['Quote', 'Customer', 'Status', 'Amount', 'Outstanding', 'Age (days)'];
    const rows = filtered.map((q) => {
      const outstanding = q.quoteAmount - q.paidAmount;
      const age = dayjs().diff(dayjs(q.createdAt), 'day');
      const status = statusOf(q);
      return [
        q.quoteNumber ?? q._id,
        q.clientDetails?.companyName ?? q.quoteName ?? 'Untitled quote',
        status.charAt(0).toUpperCase() + status.slice(1),
        String(q.quoteAmount),
        String(outstanding),
        String(age),
      ];
    });
    const csv = [header, ...rows].map((row) => row.map((cell) => csvEscape(cell)).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quotes-${dateFrom}-to-${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className={styles.card}>
      <div className={styles.title}>Quotes</div>
      <p className={styles.subtitle}>Paid and outstanding reflect each quote's linked invoice status.</p>

      <div className={styles.toolbar}>
        <Input
          placeholder="Search quote or customer"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          leftIcon={<FiSearch />}
        />
        <div className={styles.filterChips}>
          {(['all', 'approved', 'awaiting', 'rejected'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={clsx(styles.filterChip, statusFilter === f && styles.filterChipActive)}
              onClick={() => {
                setStatusFilter(f);
                setPage(1);
              }}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.actionBtn} onClick={() => setSortDesc((v) => !v)}>
            {sortDesc ? <FiArrowDown size={13} /> : <FiArrowUp size={13} />}
            {sortDesc ? 'Highest value' : 'Lowest value'}
          </button>
          <button type="button" className={styles.actionBtn} onClick={handleExport} disabled={filtered.length === 0}>
            <FiDownload size={13} />
            Export
          </button>
        </div>
      </div>

      {quotes.length === 0 ? (
        <div className={styles.empty}>No quotes in this period.</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Quote</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Outstanding</th>
                  <th>Age</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((q) => {
                  const status = statusOf(q);
                  const outstanding = q.quoteAmount - q.paidAmount;
                  const age = dayjs().diff(dayjs(q.createdAt), 'day');
                  return (
                    <Fragment key={q._id}>
                      <tr className={styles.row} onClick={() => setExpandedId(expandedId === q._id ? null : q._id)}>
                        <td className={styles.quoteCell}>#{q.quoteNumber ?? q._id.slice(-4)}</td>
                        <td>{q.clientDetails?.companyName ?? q.quoteName ?? 'Untitled quote'}</td>
                        <td>
                          <span className={clsx(styles.statusPill, styles[`status-${status}`])}>
                            {status.charAt(0).toUpperCase() + status.slice(1)}
                          </span>
                        </td>
                        <td className={styles.amountCell}>{money(q.quoteAmount)}</td>
                        <td className={styles.amountCell}>{money(outstanding)}</td>
                        <td className={styles.ageCell}>{age}d</td>
                        <td>
                          <FiChevronDown className={clsx(styles.chevron, expandedId === q._id && styles.chevronOpen)} />
                        </td>
                      </tr>
                      {expandedId === q._id && (
                        <tr className={styles.detailRow}>
                          <td colSpan={7}>
                            <div className={styles.detailContent}>
                              {q.clientDetails?.contactName && <span>Contact: {q.clientDetails.contactName}</span>}
                              {q.clientDetails?.email && <span>Email: {q.clientDetails.email}</span>}
                              {q.clientDetails?.phone && <span>Phone: {q.clientDetails.phone}</span>}
                              {q.dueDate && <span>Due: {dayjs(q.dueDate).format('MMM D, YYYY')}</span>}
                              <span>Paid: {money(q.paidAmount)}</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={styles.footer}>
            <span className={styles.footerText}>
              Showing {pageRows.length} of {filtered.length} quote{filtered.length === 1 ? '' : 's'}
            </span>
            <div className={styles.pager}>
              <button type="button" className={styles.pagerBtn} disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <button
                type="button"
                className={styles.pagerBtn}
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
