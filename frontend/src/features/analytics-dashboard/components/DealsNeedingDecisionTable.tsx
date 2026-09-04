import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { FiSearch, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { Card, Input } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { dealsService } from '@/services/dealsService';
import { quotesService } from '@/services/quotesService';
import styles from './DealsNeedingDecisionTable.module.css';

interface Row {
  quoteId: string;
  customerName: string;
  quoteNumber?: string;
  ownerName: string;
  approved: boolean;
  value: number;
  closeDate?: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

const PAGE_SIZE = 6;

export interface DealsNeedingDecisionTableProps {
  dateFrom: string;
  dateTo: string;
  storeId?: string;
  // userId -> display name, built by the caller from data already fetched
  // for the Overview tab (employeeLeaderboard/workBreakdown) — Deal only
  // ever carries ownerId, never a name, and the one endpoint that resolves
  // names (GET /users) is admin-only, which would 403 for manager/consultant
  // viewers of this same page. Reusing already-loaded team data sidesteps
  // both problems instead of guessing at a name.
  ownerNames: Map<string, string>;
}

// "Needing a decision" = quotes tied to a still-OPEN deal in the selected
// period — a client hasn't approved yet ("Awaiting response") or has
// ("Approved") but the deal itself isn't won/lost yet either way, so
// something about it is still undecided. Built by joining two real,
// already-used endpoints (dealsService/quotesService) client-side — there's
// no single backend endpoint for this exact join. No per-row "likelihood %"
// is shown: no such field exists on Quote or Deal anywhere in this app.
export function DealsNeedingDecisionTable({ dateFrom, dateTo, storeId, ownerNames }: DealsNeedingDecisionTableProps) {
  const { data: openDeals } = useQuery({
    queryKey: ['analytics-decision-open-deals', dateFrom, dateTo, storeId],
    queryFn: () =>
      dealsService.listFiltered(
        { dealStatus: ['open'], dateFrom, dateTo, dateField: 'expectedClosingDate', ...(storeId ? { storeId: [storeId] } : {}) },
        1,
        100,
      ),
  });

  const { data: quotesInRange } = useQuery({
    queryKey: ['analytics-decision-quotes', dateFrom, dateTo],
    queryFn: () => quotesService.listFiltered({ dateFrom, dateTo }, 1, 100),
  });

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'awaiting'>('all');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    if (!openDeals || !quotesInRange) return [];
    const dealById = new Map(openDeals.items.map((d) => [d._id, d]));
    const list: Row[] = [];
    for (const q of quotesInRange.items) {
      if (!q.dealId) continue;
      const deal = dealById.get(q.dealId);
      if (!deal) continue;
      list.push({
        quoteId: q._id,
        customerName: q.clientDetails?.companyName || q.quoteName || deal.name,
        quoteNumber: q.quoteNumber,
        ownerName: (deal.ownerId && ownerNames.get(deal.ownerId)) || '—',
        approved: q.clientApprovalStatus === 'approved',
        value: q.quoteAmount,
        closeDate: deal.expectedClosingDate ?? q.dueDate,
        contactName: q.clientDetails?.contactName,
        email: q.clientDetails?.email,
        phone: q.clientDetails?.phone,
      });
    }
    return list.sort((a, b) => (a.closeDate ?? '').localeCompare(b.closeDate ?? ''));
  }, [openDeals, quotesInRange, ownerNames]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter === 'approved' && !r.approved) return false;
      if (statusFilter === 'awaiting' && r.approved) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        if (!r.customerName.toLowerCase().includes(q) && !r.ownerName.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.label}>Detailed View</div>
          <div className={styles.title}>Deals needing a decision</div>
        </div>
        <button
          type="button"
          className={styles.viewAllBtn}
          onClick={() => {
            setQuery('');
            setStatusFilter('all');
            setPage(1);
          }}
        >
          View all <FiChevronRight size={14} />
        </button>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <Input
            placeholder="Search deals, customers, owners"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            leftIcon={<FiSearch />}
          />
          <div className={styles.filterChips}>
            {(['all', 'awaiting', 'approved'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={clsx(styles.filterChip, statusFilter === f && styles.filterChipActive)}
                onClick={() => {
                  setStatusFilter(f);
                  setPage(1);
                }}
              >
                {f === 'all' ? 'All' : f === 'awaiting' ? 'Awaiting response' : 'Approved'}
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className={styles.empty}>No open deals with quotes in this period.</div>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Owner</th>
                    <th>Status</th>
                    <th>Value</th>
                    <th>Close Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <Fragment key={r.quoteId}>
                      <tr className={styles.row} onClick={() => setExpandedId(expandedId === r.quoteId ? null : r.quoteId)}>
                        <td>
                          <div className={styles.customerCell}>
                            <span className={styles.avatar}>{r.customerName.charAt(0).toUpperCase()}</span>
                            <div>
                              <div className={styles.customerName}>{r.customerName}</div>
                              {r.quoteNumber && <div className={styles.customerMeta}>Quote #{r.quoteNumber}</div>}
                            </div>
                          </div>
                        </td>
                        <td>{r.ownerName}</td>
                        <td>
                          <span className={clsx(styles.statusPill, r.approved ? styles.statusApproved : styles.statusAwaiting)}>
                            {r.approved ? 'Approved' : 'Awaiting response'}
                          </span>
                        </td>
                        <td className={styles.valueCell}>{money(r.value)}</td>
                        <td>{r.closeDate ? dayjs(r.closeDate).format('MMM DD') : '—'}</td>
                        <td>
                          <FiChevronDown className={clsx(styles.chevron, expandedId === r.quoteId && styles.chevronOpen)} />
                        </td>
                      </tr>
                      {expandedId === r.quoteId && (r.contactName || r.email || r.phone) && (
                        <tr className={styles.detailRow}>
                          <td colSpan={6}>
                            <div className={styles.detailContent}>
                              {r.contactName && <span>Contact: {r.contactName}</span>}
                              {r.email && <span>Email: {r.email}</span>}
                              {r.phone && <span>Phone: {r.phone}</span>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.footer}>
              <span className={styles.footerText}>
                Showing {pageRows.length} of {filtered.length} deal{filtered.length === 1 ? '' : 's'}
              </span>
              <div className={styles.pager}>
                <button type="button" className={styles.pagerBtn} disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <span className={styles.pageNum}>{currentPage}</span>
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
      </div>
    </Card>
  );
}
