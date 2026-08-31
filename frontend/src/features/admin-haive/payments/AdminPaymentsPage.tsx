import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSearch } from 'react-icons/fi';
import { Badge, DateRangeControl, Dropdown, Input, Skeleton, type DateRange } from '@/components/ui';
import { billingAdminService, type AdminPaymentRecord } from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { formatCurrency } from '@/utils/currency';
import shared from '../adminShared.module.css';

const STATUSES = ['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'];
const PROVIDERS = ['razorpay', 'stripe', 'cashfree'];

const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  captured: 'success',
  failed: 'danger',
  refunded: 'warning',
  partially_refunded: 'warning',
  created: 'neutral',
  authorized: 'neutral',
};

function FilterDropdown({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (v?: string) => void }) {
  return (
    <Dropdown
      trigger={
        <button
          type="button"
          style={{
            padding: '8px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-surface-elevated)',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {value ?? label}
        </button>
      }
      items={[{ id: 'all', label: `All ${label.toLowerCase()}`, onSelect: () => onChange(undefined) }, ...options.map((o) => ({ id: o, label: o, onSelect: () => onChange(o) }))]}
    />
  );
}

export function AdminPaymentsPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<DateRange>({});
  const [rows, setRows] = useState<AdminPaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(true);
      billingAdminService
        .listPayments({
          organizationId: organizationId || undefined,
          status,
          provider,
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          limit: 100,
        })
        .then(setRows)
        .catch((error) => toast.error(extractErrorMessage(error)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timeout);
  }, [organizationId, status, provider, range]);

  return (
    <div className={shared.page}>
      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>Payments</h1>
          <p className={shared.pageSubtitle}>Every checkout, subscription charge, and Auto Recharge attempt across the platform.</p>
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
        <FilterDropdown label="Status" value={status} options={STATUSES} onChange={setStatus} />
        <FilterDropdown label="Gateway" value={provider} options={PROVIDERS} onChange={setProvider} />
        <DateRangeControl value={range} onChange={setRange} />
      </div>

      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Organization</th>
              <th>Type</th>
              <th>Gateway</th>
              <th>Amount</th>
              <th>Credits</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className={shared.emptyState}>
                  No payments match these filters.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((p) => (
                <tr key={p._id}>
                  <td>{formatFullDate(p.createdAt)}</td>
                  <td className={shared.mono}>{p.organizationId}</td>
                  <td>{p.type}</td>
                  <td>{p.provider}</td>
                  <td>
                    {formatCurrency(p.amount, p.currency)}
                    {p.simulated && (
                      <span style={{ marginLeft: 6 }}>
                        <Badge variant="warning">simulated</Badge>
                      </span>
                    )}
                  </td>
                  <td>{p.creditsGranted.toLocaleString()}</td>
                  <td>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'neutral'}>{p.status}</Badge>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
