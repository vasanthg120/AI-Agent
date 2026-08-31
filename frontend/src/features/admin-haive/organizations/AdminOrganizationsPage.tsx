import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Input, Skeleton } from '@/components/ui';
import { billingAdminService, type OrganizationBilling } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminPagination } from '../components/AdminPagination';
import shared from '../adminShared.module.css';

const LIMIT = 20;

export function AdminOrganizationsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<OrganizationBilling[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      billingAdminService
        .getOrganizationsPage({ page, limit: LIMIT, search: search || undefined, sortBy: 'createdAt' })
        .then((result) => {
          setItems(result.items);
          setTotal(result.total);
        })
        .catch((error) => toast.error(extractErrorMessage(error)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [page, search]);

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Organizations</h1>
          <p className={shared.pageSubtitle}>Every organization on the platform — plan, wallet, usage, and revenue at a glance.</p>
        </div>
        <div className={shared.toolbar}>
          <Input
            className={shared.searchInput}
            placeholder="Search by name or slug..."
            leftIcon={<FiSearch />}
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
          />
        </div>
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Users</th>
              <th>Plan</th>
              <th>Wallet</th>
              <th>Credits Used</th>
              <th>Subscription</th>
              <th>Revenue</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={9}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={9} className={shared.emptyState}>
                  No organizations match this search.
                </td>
              </tr>
            )}
            {!loading &&
              items.map((org) => (
                <tr key={org.organizationId} className={shared.tableRow} onClick={() => navigate(ADMIN_ROUTES.organizationDetail(org.organizationId))}>
                  <td>
                    <div>{org.name}</div>
                    <div className={shared.mono}>{org.slug}</div>
                  </td>
                  <td>{org.userCount}</td>
                  <td>{org.planName ?? '—'}</td>
                  <td>{org.walletBalanceCredits.toLocaleString()} cr</td>
                  <td>{org.creditsUsed.toLocaleString()} cr</td>
                  <td>
                    {org.subscriptionStatus ? (
                      <Badge variant={org.subscriptionStatus === 'active' ? 'success' : org.subscriptionStatus === 'past_due' ? 'warning' : 'neutral'}>
                        {org.subscriptionStatus}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>${org.revenueUsd.toFixed(2)}</td>
                  <td>
                    <Badge variant={org.status === 'active' ? 'success' : 'danger'}>{org.status}</Badge>
                  </td>
                  <td>{new Date(org.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} limit={LIMIT} total={total} onChange={setPage} />
    </div>
  );
}
