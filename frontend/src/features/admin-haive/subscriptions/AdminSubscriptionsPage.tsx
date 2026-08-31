import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Button, Dropdown, Input, Skeleton } from '@/components/ui';
import { billingAdminService, type AdminSubscriptionSummary } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { AdminPagination } from '../components/AdminPagination';
import shared from '../adminShared.module.css';

const STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'];
const LIMIT = 25;

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  trialing: 'success',
  past_due: 'warning',
  canceled: 'neutral',
  expired: 'danger',
};

export function AdminSubscriptionsPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AdminSubscriptionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    billingAdminService
      .listSubscriptions({ organizationId: organizationId || undefined, status, page, limit: LIMIT })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timeout = setTimeout(load, 250);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, status, page]);

  const handleCancel = async (id: string) => {
    setActingId(id);
    try {
      await billingAdminService.cancelSubscription(id);
      toast.success('Subscription set to cancel at period end.');
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setActingId(null);
    }
  };

  const handleReactivate = async (id: string) => {
    setActingId(id);
    try {
      await billingAdminService.reactivateSubscription(id);
      toast.success('Cancellation cleared — subscription will renew normally.');
      load();
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Subscriptions</h1>
          <p className={shared.pageSubtitle}>Every organization's plan subscription. Cancel/reactivate reuse the same soft-cancel the customer uses.</p>
        </div>
      </div>

      <div className={shared.toolbar}>
        <Input
          className={shared.searchInput}
          placeholder="Filter by organization id..."
          leftIcon={<FiSearch />}
          value={organizationId}
          onChange={(event) => {
            setPage(1);
            setOrganizationId(event.target.value);
          }}
        />
        <Dropdown
          trigger={
            <button type="button" style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-surface-elevated)', color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)' }}>
              {status ?? 'All statuses'}
            </button>
          }
          items={[
            { id: 'all', label: 'All statuses', onSelect: () => { setPage(1); setStatus(undefined); } },
            ...STATUSES.map((s) => ({ id: s, label: s, onSelect: () => { setPage(1); setStatus(s); } })),
          ]}
        />
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Plan</th>
              <th>Price</th>
              <th>Status</th>
              <th>Renews</th>
              <th>Cancel at Period End</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className={shared.emptyState}>
                  No subscriptions match these filters.
                </td>
              </tr>
            )}
            {!loading &&
              items.map((sub) => (
                <tr key={sub.id}>
                  <td className={shared.mono}>{sub.organizationId}</td>
                  <td>{sub.plan?.name ?? '—'}</td>
                  <td>{sub.price ? `${sub.price.amount} ${sub.price.currencyCode} / ${sub.price.billingCycle}` : '—'}</td>
                  <td>
                    <Badge variant={STATUS_VARIANT[sub.status] ?? 'neutral'}>{sub.status}</Badge>
                  </td>
                  <td>{formatFullDate(sub.currentPeriodEnd)}</td>
                  <td>{sub.cancelAtPeriodEnd ? 'Yes' : 'No'}</td>
                  <td>
                    {['trialing', 'active', 'past_due'].includes(sub.status) &&
                      (sub.cancelAtPeriodEnd ? (
                        <Button size="sm" variant="secondary" loading={actingId === sub.id} onClick={() => handleReactivate(sub.id)}>
                          Reactivate
                        </Button>
                      ) : (
                        <Button size="sm" variant="danger" loading={actingId === sub.id} onClick={() => handleCancel(sub.id)}>
                          Cancel
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} limit={LIMIT} total={total} onChange={setPage} />
    </div>
  );
}
