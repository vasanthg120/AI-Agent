import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, DateRangeControl, Dropdown, Input, Skeleton, type DateRange } from '@/components/ui';
import { billingAdminService, type AdminWalletTransaction } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import shared from '../adminShared.module.css';

const TRANSACTION_TYPES = [
  'FREE_TRIAL',
  'PURCHASE',
  'AI_USAGE',
  'AUTO_RECHARGE',
  'BONUS',
  'PROMOTION',
  'REFUND',
  'MANUAL_ADJUSTMENT',
  'SUBSCRIPTION_GRANT',
];

const TYPE_VARIANT: Record<string, 'success' | 'danger' | 'accent' | 'neutral'> = {
  PURCHASE: 'success',
  SUBSCRIPTION_GRANT: 'success',
  BONUS: 'success',
  PROMOTION: 'success',
  AUTO_RECHARGE: 'success',
  FREE_TRIAL: 'success',
  AI_USAGE: 'accent',
  REFUND: 'danger',
  MANUAL_ADJUSTMENT: 'neutral',
};

// The Credit Ledger — every mutation WalletService.applyLedgerEntry has ever
// written, filtered but never recomputed. This IS the source of truth for
// explaining a wallet's balance; nothing here is a derived/estimated figure.
export function AdminLedgerPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [type, setType] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<DateRange>({});
  const [rows, setRows] = useState<AdminWalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      billingAdminService
        .listTransactions({
          organizationId: organizationId || undefined,
          type,
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          limit: 100,
        })
        .then(setRows)
        .catch((error) => toast.error(extractErrorMessage(error)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [organizationId, type, range]);

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Credit Ledger</h1>
          <p className={shared.pageSubtitle}>Every credit mutation across the platform — the ledger explains every wallet balance.</p>
        </div>
      </div>

      <div className={shared.toolbar}>
        <Input
          className={shared.searchInput}
          placeholder="Filter by organization id..."
          leftIcon={<FiSearch />}
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
        />
        <Dropdown
          trigger={
            <button type="button" className={shared.mono} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-surface-elevated)', color: 'var(--color-text-primary)' }}>
              {type ?? 'All types'}
            </button>
          }
          items={[
            { id: 'all', label: 'All types', onSelect: () => setType(undefined) },
            ...TRANSACTION_TYPES.map((t) => ({ id: t, label: t, onSelect: () => setType(t) })),
          ]}
        />
        <DateRangeControl value={range} onChange={setRange} />
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Organization</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Balance After</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={6}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className={shared.emptyState}>
                  No ledger entries match these filters.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={row._id}>
                  <td>{formatFullDate(row.createdAt)}</td>
                  <td className={shared.mono}>{row.organizationId}</td>
                  <td>
                    <Badge variant={TYPE_VARIANT[row.type] ?? 'neutral'}>{row.type}</Badge>
                  </td>
                  <td>
                    {row.amountCredits > 0 ? '+' : ''}
                    {row.amountCredits.toLocaleString()} cr
                  </td>
                  <td>{row.balanceAfterCredits.toLocaleString()} cr</td>
                  <td>{row.createdBy}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
