import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiArrowLeft } from 'react-icons/fi';
import { Badge, SectionCard, Skeleton, StatTile, Tabs } from '@/components/ui';
import {
  billingAdminService,
  type AdminInvoice,
  type AdminPaymentRecord,
  type AdminWalletTransaction,
  type OrganizationDetail,
} from '@/services/billingAdminService';
import { extractErrorMessage } from '@/utils/errors';
import { formatFullDate } from '@/utils/date';
import { ADMIN_ROUTES } from '@/constants/routes';
import shared from '../adminShared.module.css';

type TabId = 'overview' | 'users' | 'wallet' | 'ledger' | 'usage' | 'subscriptions' | 'payments' | 'invoices';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'ledger', label: 'Credit Ledger' },
  { id: 'usage', label: 'Usage' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'payments', label: 'Payments' },
  { id: 'invoices', label: 'Invoices' },
];

interface OrgUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  active: boolean;
}

export function AdminOrganizationDetailPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const [tab, setTab] = useState<TabId>('overview');
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [users, setUsers] = useState<OrgUser[] | null>(null);
  const [ledger, setLedger] = useState<AdminWalletTransaction[] | null>(null);
  const [usage, setUsage] = useState<AdminWalletTransaction[] | null>(null);
  const [payments, setPayments] = useState<AdminPaymentRecord[] | null>(null);
  const [invoices, setInvoices] = useState<AdminInvoice[] | null>(null);
  const [tabLoading, setTabLoading] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    setLoading(true);
    billingAdminService
      .getOrganizationDetail(organizationId)
      .then(setDetail)
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setLoading(false));
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    setTabLoading(true);
    const load = async () => {
      if (tab === 'users' && users === null) {
        setUsers(await billingAdminService.getOrganizationUsers(organizationId));
      } else if (tab === 'ledger' && ledger === null) {
        setLedger(await billingAdminService.listTransactions({ organizationId, limit: 100 }));
      } else if (tab === 'usage' && usage === null) {
        setUsage(await billingAdminService.listTransactions({ organizationId, type: 'AI_USAGE', limit: 100 }));
      } else if (tab === 'payments' && payments === null) {
        setPayments(await billingAdminService.listPayments({ organizationId, limit: 100 }));
      } else if (tab === 'invoices' && invoices === null) {
        setInvoices(await billingAdminService.listInvoices({ organizationId, limit: 100 }));
      }
    };
    load()
      .catch((error) => toast.error(extractErrorMessage(error)))
      .finally(() => setTabLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, organizationId]);

  if (loading || !detail) {
    return (
      <div className={shared.page}>
        <Skeleton height={32} width={280} />
        <Skeleton height={140} />
      </div>
    );
  }

  return (
    <div className={shared.page}>
      <Link to={ADMIN_ROUTES.organizations} className={shared.backLink}>
        <FiArrowLeft size={14} /> Organizations
      </Link>

      <div className={shared.headerRow}>
        <div>
          <h1 className={shared.pageTitle}>{detail.name}</h1>
          <p className={shared.pageSubtitle}>
            <span className={shared.mono}>{detail.organizationId}</span> · Created {formatFullDate(detail.createdAt)}
          </p>
        </div>
        <Badge variant={detail.status === 'active' ? 'success' : 'danger'}>{detail.status}</Badge>
      </div>

      <div className={shared.tabsBar}>
        <Tabs items={TABS} activeId={tab} onChange={(id) => setTab(id as TabId)} />
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={detail.userCount} label="Users" />
            <StatTile value={`${detail.wallet.availableCredits.toLocaleString()} cr`} label="Wallet Balance" />
            <StatTile value={`${detail.lifetimeCreditsUsed.toLocaleString()} cr`} label="Credits Used" />
            <StatTile value={`$${detail.lifetimeRevenueUsd.toFixed(2)}`} label="Lifetime Revenue" />
            <StatTile value={detail.subscription?.status ?? 'None'} label="Subscription" />
          </div>
          <SectionCard title="Plan">
            {detail.subscription ? (
              <div style={{ fontSize: 'var(--text-sm)' }}>
                <div>
                  <strong>{detail.subscription.plan?.name ?? 'Unknown plan'}</strong> — {detail.subscription.price?.billingCycle}
                </div>
                <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
                  Renews {formatFullDate(detail.subscription.currentPeriodEnd)}
                  {detail.subscription.cancelAtPeriodEnd && ' · cancels at period end'}
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>No active subscription.</p>
            )}
          </SectionCard>
        </div>
      )}

      {tab === 'users' && (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Roles</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tabLoading && (
                <tr>
                  <td colSpan={4}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              )}
              {!tabLoading && (users ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className={shared.emptyState}>
                    No users found.
                  </td>
                </tr>
              )}
              {!tabLoading &&
                (users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.roles.join(', ')}</td>
                    <td>
                      <Badge variant={u.active ? 'success' : 'neutral'}>{u.active ? 'active' : 'inactive'}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'wallet' && (
        <SectionCard title="Wallet">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 'var(--space-4)' }}>
            <StatTile value={detail.wallet.balanceCredits.toLocaleString()} label="Balance Credits" />
            <StatTile value={detail.wallet.reservedCredits.toLocaleString()} label="Reserved Credits" />
            <StatTile value={detail.wallet.availableCredits.toLocaleString()} label="Available Credits" />
            <StatTile value={detail.wallet.autoPay.enabled ? 'Enabled' : 'Disabled'} label="Auto Recharge" />
          </div>
        </SectionCard>
      )}

      {(tab === 'ledger' || tab === 'usage') && (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Balance After</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {tabLoading && (
                <tr>
                  <td colSpan={5}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              )}
              {!tabLoading && (tab === 'ledger' ? ledger : usage)?.length === 0 && (
                <tr>
                  <td colSpan={5} className={shared.emptyState}>
                    No transactions found.
                  </td>
                </tr>
              )}
              {!tabLoading &&
                (tab === 'ledger' ? ledger : usage)?.map((row) => (
                  <tr key={row._id}>
                    <td>{formatFullDate(row.createdAt)}</td>
                    <td>{row.type}</td>
                    <td>{row.amountCredits.toLocaleString()} cr</td>
                    <td>{row.balanceAfterCredits.toLocaleString()} cr</td>
                    <td>{row.createdBy}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'subscriptions' && (
        <SectionCard title="Current Subscription">
          {detail.subscription ? (
            <div style={{ fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                Plan: <strong>{detail.subscription.plan?.name ?? 'Unknown'}</strong>
              </div>
              <div>
                Status: <Badge variant={detail.subscription.status === 'active' ? 'success' : 'neutral'}>{detail.subscription.status}</Badge>
              </div>
              <div>Period: {formatFullDate(detail.subscription.currentPeriodStart)} – {formatFullDate(detail.subscription.currentPeriodEnd)}</div>
              <div>Cancel at period end: {detail.subscription.cancelAtPeriodEnd ? 'Yes' : 'No'}</div>
            </div>
          ) : (
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', margin: 0 }}>No active subscription.</p>
          )}
        </SectionCard>
      )}

      {tab === 'payments' && (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Provider</th>
                <th>Amount</th>
                <th>Credits</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tabLoading && (
                <tr>
                  <td colSpan={6}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              )}
              {!tabLoading && (payments ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className={shared.emptyState}>
                    No payments found.
                  </td>
                </tr>
              )}
              {!tabLoading &&
                (payments ?? []).map((p) => (
                  <tr key={p._id}>
                    <td>{formatFullDate(p.createdAt)}</td>
                    <td>{p.type}</td>
                    <td>{p.provider}</td>
                    <td>
                      {p.amount} {p.currency}
                    </td>
                    <td>{p.creditsGranted.toLocaleString()}</td>
                    <td>
                      <Badge variant={p.status === 'captured' ? 'success' : p.status === 'failed' ? 'danger' : 'neutral'}>{p.status}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'invoices' && (
        <div className={shared.tableWrap}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Issued</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tabLoading && (
                <tr>
                  <td colSpan={4}>
                    <Skeleton height={20} />
                  </td>
                </tr>
              )}
              {!tabLoading && (invoices ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className={shared.emptyState}>
                    No invoices found.
                  </td>
                </tr>
              )}
              {!tabLoading &&
                (invoices ?? []).map((inv) => (
                  <tr key={inv._id}>
                    <td className={shared.mono}>{inv.invoiceNumber}</td>
                    <td>{formatFullDate(inv.issuedAt)}</td>
                    <td>
                      {inv.total} {inv.currencyCode}
                    </td>
                    <td>
                      <Badge variant={inv.status === 'paid' ? 'success' : 'neutral'}>{inv.status}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
