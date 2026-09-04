import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FiPlus, FiSearch } from 'react-icons/fi';
import { Badge, Button, Input, Skeleton } from '@/components/ui';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { quotesService } from '@/services/quotesService';
import { ROUTES } from '@/constants/routes';
import styles from './quotes.module.css';

const STATUS_OPTIONS = [
  { value: '', label: 'All approval statuses' },
  { value: 'approved', label: 'Approved' },
  { value: 'not-approved', label: 'Not approved' },
];

const APPROVAL_BADGE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  approved: 'success',
  rejected: 'danger',
  pending: 'warning',
};

// New — the first dedicated Quote list page this app has had. Structural
// template: DealAssignmentSettings.tsx's table (search + status filter +
// manual pagination) and QuotesLedgerTable.tsx's quote-specific field
// choices (quoteNumber/clientDetails/status), per the Quotes in Pipeline V1
// plan.
export function QuotesListPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [clientApprovalStatus, setClientApprovalStatus] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading, error } = useQuery({
    queryKey: ['quotes-list', clientApprovalStatus, page],
    queryFn: () => quotesService.listFiltered({ clientApprovalStatus: clientApprovalStatus || undefined }, page, pageSize),
  });

  const items = data?.items ?? [];
  const filtered = search.trim()
    ? items.filter((q) => {
        const needle = search.trim().toLowerCase();
        return (
          q.quoteNumber?.toLowerCase().includes(needle) ||
          q.quoteName?.toLowerCase().includes(needle) ||
          q.clientDetails?.companyName?.toLowerCase().includes(needle) ||
          q.clientDetails?.email?.toLowerCase().includes(needle)
        );
      })
    : items;

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>Quotes</h1>
          <p className={styles.pageSubtitle}>Create, price, and track customer quotes.</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => navigate(ROUTES.quoteProducts)}>
            Products &amp; Services
          </Button>
          <Button leftIcon={<FiPlus />} onClick={() => navigate(ROUTES.quoteNew)}>
            Create Quote
          </Button>
        </div>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterRow}>
          <div className={styles.valueField} style={{ width: 280 }}>
            <Input
              leftIcon={<FiSearch />}
              placeholder="Search by quote #, name, customer, email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className={styles.select}
            value={clientApprovalStatus}
            onChange={(e) => {
              setClientApprovalStatus(e.target.value);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <Skeleton height={320} />
      ) : error ? (
        <div className={styles.emptyState}>{extractErrorMessage(error)}</div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>No quotes match this filter.</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Quote #</th>
                  <th>Customer</th>
                  <th>Linked Deal</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Approval</th>
                  <th>Valid until</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q) => (
                  <tr key={q._id} className={styles.clickableRow} onClick={() => navigate(ROUTES.quoteDetail(q._id))}>
                    <td>
                      <div className={styles.listItemMain}>
                        <span className={styles.listItemTitle}>{q.quoteNumber ?? '—'}</span>
                        {q.quoteName && <span className={styles.listItemMeta}>{q.quoteName}</span>}
                      </div>
                    </td>
                    <td>{q.clientDetails?.companyName ?? q.clientDetails?.email ?? '—'}</td>
                    <td>{q.dealId ? <span className={styles.listItemMeta}>Linked</span> : <span className={styles.listItemMeta}>No linked deal</span>}</td>
                    <td>{formatCurrency(q.quoteAmount, q.currency)}</td>
                    <td>
                      <Badge variant="neutral">{q.quoteStatus}</Badge>
                    </td>
                    <td>
                      <Badge variant={APPROVAL_BADGE[q.clientApprovalStatus] ?? 'neutral'}>{q.clientApprovalStatus}</Badge>
                    </td>
                    <td>{q.expirationDate ?? '—'}</td>
                    <td>{new Date(q.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.paginationRow}>
            <span className={styles.listItemMeta}>{data?.total ?? 0} quote(s)</span>
            {totalPages > 1 && (
              <div className={styles.paginationControls}>
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className={styles.listItemMeta}>
                  Page {page} of {totalPages}
                </span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
