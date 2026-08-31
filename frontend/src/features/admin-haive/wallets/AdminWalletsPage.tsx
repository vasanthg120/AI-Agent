import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, Input, Skeleton } from '@/components/ui';
import { billingAdminService, type AdminWalletRow } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminPagination } from '../components/AdminPagination';
import shared from '../adminShared.module.css';

const LIMIT = 25;

// Read-only over WalletService's own numbers — see
// billing-admin.service.ts's listWallets doc comment. No balance mutation
// happens from this page; adjustments still go through the existing ledger
// (WalletService.applyLedgerEntry), never a direct balance write.
export function AdminWalletsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AdminWalletRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      billingAdminService
        .listWallets({ page, limit: LIMIT, search: search || undefined })
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
          <h1 className={shared.pageTitle}>Wallets</h1>
          <p className={shared.pageSubtitle}>Every organization's credit balance — the same numbers WalletService.getSummary computes.</p>
        </div>
        <Input
          className={shared.searchInput}
          placeholder="Search by organization id..."
          leftIcon={<FiSearch />}
          value={search}
          onChange={(event) => {
            setPage(1);
            setSearch(event.target.value);
          }}
        />
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Balance</th>
              <th>Reserved</th>
              <th>Available</th>
              <th>Auto Recharge</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={5}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className={shared.emptyState}>
                  No wallets match this search.
                </td>
              </tr>
            )}
            {!loading &&
              items.map((w) => (
                <tr key={w.walletId} className={shared.tableRow} onClick={() => navigate(ADMIN_ROUTES.organizationDetail(w.organizationId))}>
                  <td>
                    <div>{w.organizationName}</div>
                    <div className={shared.mono}>{w.organizationId}</div>
                  </td>
                  <td>{w.balanceCredits.toLocaleString()} cr</td>
                  <td>{w.reservedCredits.toLocaleString()} cr</td>
                  <td>{w.availableCredits.toLocaleString()} cr</td>
                  <td>
                    <Badge variant={w.autoPayEnabled ? 'success' : 'neutral'}>{w.autoPayEnabled ? 'Enabled' : 'Disabled'}</Badge>
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
