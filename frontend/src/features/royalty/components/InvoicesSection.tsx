import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Badge, Button, DateRangeControl, SectionCard, Skeleton, type DateRange } from '@/components/ui';
import { formatINR as money } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { invoicesService, type Invoice } from '@/services/invoicesService';
import styles from '../royalty.module.css';

const PAGE_SIZE = 20;

const STATUS_VARIANT: Record<Invoice['invoiceStatus'], 'neutral' | 'warning' | 'success'> = {
  draft: 'neutral',
  invoiced: 'warning',
  paid: 'success',
};

// The one place a human actually confirms cash came in — see backend
// InvoicesService's own comment on why neither the external CRM nor Deal/
// Quote can supply this automatically. Marking an invoice Paid/Draft here
// is what drives the Dashboard's Pipeline & Quotes "Paid" column; nothing
// on that page writes payment state directly, so there's exactly one place
// this can happen.
export function InvoicesSection() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<DateRange>({});
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [costDraft, setCostDraft] = useState('');

  const filters = { dateFrom: range.dateFrom, dateTo: range.dateTo, invoiceStatus: statusFilter };

  const { data: list, isLoading } = useQuery({
    queryKey: ['royalty-invoices', filters, page],
    queryFn: () => invoicesService.listFiltered(filters, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const toggleStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'draft' | 'paid' }) => invoicesService.setStatus(id, next),
    onMutate: ({ id }) => setPendingId(id),
    onSuccess: async (_data, { next }) => {
      toast.success(next === 'paid' ? 'Marked paid' : 'Marked unpaid');
      await queryClient.invalidateQueries({ queryKey: ['royalty-invoices'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
    onSettled: () => setPendingId(null),
  });

  // The Gross Margin report (Reporting > Gross Margin) is computed entirely
  // from this field — before this, there was no UI anywhere to set it, so
  // the report could never show real data no matter how many invoices
  // existed. This is that missing entry point.
  const updateCost = useMutation({
    mutationFn: ({ id, costAmount }: { id: string; costAmount: number }) => invoicesService.setCost(id, costAmount),
    onSuccess: async () => {
      toast.success('Cost saved');
      await queryClient.invalidateQueries({ queryKey: ['royalty-invoices'] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
    onSettled: () => setEditingCostId(null),
  });

  const startEditCost = (inv: Invoice) => {
    setEditingCostId(inv._id);
    setCostDraft(inv.costAmount !== undefined ? String(inv.costAmount) : '');
  };

  const submitCost = (id: string) => {
    const parsed = Number(costDraft);
    if (costDraft.trim() === '' || Number.isNaN(parsed) || parsed < 0) {
      setEditingCostId(null);
      return;
    }
    updateCost.mutate({ id, costAmount: parsed });
  };

  return (
    <div className={styles.section}>
      <div className={styles.filterBar}>
        <div className={styles.filterRow}>
          <DateRangeControl value={range} onChange={(v) => { setRange(v); setPage(1); }} />
          {(['draft', 'invoiced', 'paid'] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={statusFilter.includes(s) ? 'primary' : 'ghost'}
              onClick={() => {
                setStatusFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
                setPage(1);
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <SectionCard title="Invoices">
        {isLoading || !list ? (
          <Skeleton height={280} />
        ) : list.items.length === 0 ? (
          <div className={styles.emptyState}>No invoices match the current filters.</div>
        ) : (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.reportTable}>
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Customer</th>
                    <th>Invoice Date</th>
                    <th>Value</th>
                    <th>Cost</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((inv) => (
                    <tr key={inv._id}>
                      <td>{inv.invoiceNumber}</td>
                      <td>{inv.clientDetails?.companyName ?? '—'}</td>
                      <td>{inv.invoiceDate.slice(0, 10)}</td>
                      <td>{money(inv.currentValue)}</td>
                      <td>
                        {editingCostId === inv._id ? (
                          <input
                            id={`invoice-cost-${inv._id}`}
                            type="number"
                            min={0}
                            step="0.01"
                            autoFocus
                            className={styles.costInput}
                            value={costDraft}
                            disabled={updateCost.isPending}
                            onChange={(e) => setCostDraft(e.target.value)}
                            onBlur={() => submitCost(inv._id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitCost(inv._id);
                              if (e.key === 'Escape') setEditingCostId(null);
                            }}
                          />
                        ) : (
                          <button type="button" className={styles.costButton} onClick={() => startEditCost(inv)}>
                            {inv.costAmount !== undefined ? money(inv.costAmount) : <span className={styles.costPlaceholder}>+ Add cost</span>}
                          </button>
                        )}
                      </td>
                      <td>
                        {inv.voidStatus ? (
                          <Badge variant="danger">Voided</Badge>
                        ) : (
                          <Badge variant={STATUS_VARIANT[inv.invoiceStatus]}>{inv.invoiceStatus}</Badge>
                        )}
                      </td>
                      <td>
                        {!inv.voidStatus && (
                          <Button
                            size="sm"
                            variant={inv.invoiceStatus === 'paid' ? 'ghost' : 'primary'}
                            loading={toggleStatus.isPending && pendingId === inv._id}
                            onClick={() => toggleStatus.mutate({ id: inv._id, next: inv.invoiceStatus === 'paid' ? 'draft' : 'paid' })}
                          >
                            {inv.invoiceStatus === 'paid' ? 'Mark Unpaid' : 'Mark Paid'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.pagination}>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {list.page} of {Math.max(1, Math.ceil(list.total / list.pageSize))} ({list.total} total)
              </span>
              <Button size="sm" variant="ghost" disabled={page * PAGE_SIZE >= list.total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
