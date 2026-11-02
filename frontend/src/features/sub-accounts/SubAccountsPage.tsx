import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  FiCreditCard,
  FiDollarSign,
  FiEdit2,
  FiEye,
  FiLayers,
  FiLogIn,
  FiMoreHorizontal,
  FiPauseCircle,
  FiPlayCircle,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiSend,
  FiTrash2,
  FiUserCheck,
  FiUsers,
  FiUserX,
} from 'react-icons/fi';
import { Button, Dropdown, EmptyState, IconButton, Input, Skeleton, StatTile, type DropdownItem } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { SettingsSection } from '@/features/settings/components/SettingsSection';
import { subAccountsService, type SubAccountDetails, type SubAccountRow } from '@/services/subAccountsService';
import { useAuthStore } from '@/stores/authStore';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { ArchiveSubAccountDialog } from './ArchiveSubAccountDialog';
import { SubAccountDrawer } from './SubAccountDrawer';
import { AccountLogo, AccountStatusBadge, SubscriptionBadge, formatDate, formatPrice } from './subAccountParts';
import { ACCOUNTS_QUERY_KEY, useAccounts } from './useAccounts';
import styles from './SubAccountsPage.module.css';

type Filter = 'open' | 'active' | 'suspended' | 'unpaid' | 'archived';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'unpaid', label: 'No subscription' },
  { id: 'archived', label: 'Archived' },
];

const LIVE = new Set(['trialing', 'active', 'past_due']);

function matchesFilter(row: SubAccountRow, filter: Filter): boolean {
  switch (filter) {
    case 'archived':
      return row.status === 'archived';
    case 'active':
    case 'suspended':
      return row.status === filter;
    case 'unpaid':
      return row.status !== 'archived' && !LIVE.has(row.billing.status);
    default:
      return row.status !== 'archived';
  }
}

export function SubAccountsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useAccounts();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const canManage = accounts.data?.canManageSubAccounts ?? false;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sub-accounts'],
    queryFn: subAccountsService.list,
    enabled: canManage,
  });

  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<SubAccountDetails | null>(null);
  const [archiving, setArchiving] = useState<SubAccountRow | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.subAccounts ?? [])
      .filter((row) => matchesFilter(row, filter))
      .filter((row) => !needle || [row.name, row.ownerName, row.email].some((value) => value?.toLowerCase().includes(needle)));
  }, [data, filter, search]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sub-accounts'] });
    await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
  };

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enter = async (row: SubAccountRow, destination?: string) => {
    try {
      // Reloads the app into that business when it succeeds.
      await switchAccount(row.id, destination);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const openEdit = async (row: SubAccountRow) => {
    try {
      setEditing(await subAccountsService.details(row.id));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const resend = (row: SubAccountRow) =>
    act(async () => {
      await subAccountsService.resendInvitation(row.id);
    }, `Invitation sent to ${row.email}`);

  const actionsFor = (row: SubAccountRow): DropdownItem[] => {
    const open = row.status === 'active';
    const items: DropdownItem[] = [
      { id: 'view', label: 'View details', icon: <FiEye />, onSelect: () => navigate(`${ROUTES.settingsSubAccounts}/${row.id}`) },
    ];
    if (open) {
      items.push(
        { id: 'switch', label: 'Switch to account', icon: <FiLogIn />, onSelect: () => void enter(row) },
        { id: 'users', label: 'Manage users', icon: <FiUsers />, onSelect: () => void enter(row, ROUTES.settingsUsers) },
        { id: 'subscription', label: 'Manage subscription', icon: <FiCreditCard />, onSelect: () => void enter(row, ROUTES.billing) },
      );
    }
    if (row.status !== 'archived') {
      items.push({ id: 'edit', label: 'Edit account', icon: <FiEdit2 />, onSelect: () => void openEdit(row) });
    }
    if (!row.ownerActivated && row.status !== 'archived') {
      items.push({ id: 'invite', label: 'Resend invitation', icon: <FiSend />, onSelect: () => void resend(row) });
    }
    if (open) {
      items.push({
        id: 'suspend',
        label: 'Suspend account',
        icon: <FiPauseCircle />,
        separatorBefore: true,
        onSelect: () => {
          if (window.confirm(`Suspend ${row.name}? Nobody can sign in to it until you reactivate it.`)) {
            void act(() => subAccountsService.setStatus(row.id, 'suspended'), `${row.name} suspended`);
          }
        },
      });
    }
    if (row.status === 'suspended' && row.suspendedByParent) {
      items.push({
        id: 'reactivate',
        label: 'Reactivate account',
        icon: <FiPlayCircle />,
        separatorBefore: true,
        onSelect: () => void act(() => subAccountsService.setStatus(row.id, 'active'), `${row.name} reactivated`),
      });
    }
    if (row.status === 'archived') {
      items.push({
        id: 'restore',
        label: 'Restore account',
        icon: <FiRefreshCw />,
        separatorBefore: true,
        onSelect: () => void act(() => subAccountsService.restore(row.id), `${row.name} restored`),
      });
    } else if (row.suspendedByParent || open) {
      items.push({ id: 'delete', label: 'Delete account', icon: <FiTrash2 />, danger: true, onSelect: () => setArchiving(row) });
    }
    return items;
  };

  if (accounts.isLoading) return <Skeleton height={320} />;
  if (!canManage) {
    return (
      <EmptyState
        icon={FiLayers}
        title="Sub-accounts are managed from the Main Account"
        description="Only the Main Account’s owner can create and manage sub-accounts."
      />
    );
  }

  const overview = data?.overview;
  const revenue = overview?.monthlyRevenue.length
    ? overview.monthlyRevenue.map((r) => formatCurrency(r.amount, r.currency)).join(' + ')
    : '—';

  return (
    <div className={styles.page}>
      <div className={styles.tiles}>
        <StatTile icon={FiLayers} label="Total sub-accounts" value={overview?.total ?? 0} />
        <StatTile icon={FiUserCheck} label="Active" value={overview?.active ?? 0} />
        <StatTile icon={FiUserX} label="Inactive" value={overview?.inactive ?? 0} />
        <StatTile icon={FiCreditCard} label="Pending subscriptions" value={overview?.pendingSubscriptions ?? 0} />
        <StatTile icon={FiDollarSign} label="Monthly revenue from sub-accounts" value={revenue} />
      </div>

      {data && !data.plansAvailable && (
        <p className={styles.warning} role="alert">
          There’s no subscription plan on sale right now, so new sub-accounts can’t subscribe and will stay locked. Contact
          HaiVE support.
        </p>
      )}

      <SettingsSection
        title="Sub-accounts"
        description="Each one is an independent business with its own login, data and subscription. Nothing is charged to your Main Account."
      >
        <div className={styles.toolbar}>
          <div className={styles.toolbarRow}>
            <div className={styles.search}>
              <Input
                aria-label="Search sub-accounts"
                placeholder="Search by name, owner or email"
                leftIcon={<FiSearch />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button type="button" leftIcon={<FiPlus />} onClick={() => setDrawerOpen(true)}>
              Create sub-account
            </Button>
          </div>
          <div className={styles.filters} role="group" aria-label="Filter sub-accounts">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === filter ? styles.filterActive : styles.filter}
                aria-pressed={option.id === filter}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className={styles.rows}>
            <Skeleton height={84} />
            <Skeleton height={84} />
          </div>
        ) : error ? (
          <div className={styles.errorState}>
            <p>{extractErrorMessage(error)}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FiLayers}
            title={(data?.subAccounts.length ?? 0) === 0 ? 'No sub-accounts yet' : 'Nothing matches'}
            description={
              (data?.subAccounts.length ?? 0) === 0
                ? 'Create one for each business you run. It gets its own login, data and subscription.'
                : 'Try another search or filter.'
            }
          />
        ) : (
          <ul className={styles.rows}>
            {rows.map((row) => (
              <li key={row.id} className={styles.row}>
                <button type="button" className={styles.identity} onClick={() => navigate(`${ROUTES.settingsSubAccounts}/${row.id}`)}>
                  <AccountLogo name={row.name} logo={row.logo} />
                  <span className={styles.identityText}>
                    <span className={styles.name}>{row.name}</span>
                    <span className={styles.meta}>
                      {row.ownerName ?? 'No owner'}
                      {!row.ownerActivated && row.status !== 'archived' ? ' · invited' : ''}
                    </span>
                    <span className={styles.meta}>{row.email}</span>
                    {row.phone && (
                      <span className={styles.meta}>
                        {row.phoneCountryCode} {row.phone}
                      </span>
                    )}
                  </span>
                </button>

                <div className={styles.billing}>
                  <span className={styles.badges}>
                    <AccountStatusBadge status={row.status} />
                    <SubscriptionBadge status={row.billing.status} />
                  </span>
                  <span className={styles.meta}>
                    {row.billing.planName ?? 'No plan'}
                    {row.billing.amount != null ? ` · ${formatPrice(row.billing)}` : ''}
                  </span>
                </div>

                <dl className={styles.facts}>
                  <div>
                    <dt>Users</dt>
                    <dd>{row.userCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDate(row.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Last active</dt>
                    <dd>{formatDate(row.lastActiveAt)}</dd>
                  </div>
                </dl>

                <Dropdown
                  usePortal
                  align="right"
                  items={actionsFor(row)}
                  trigger={<IconButton icon={<FiMoreHorizontal />} label={`Actions for ${row.name}`} disabled={busy} />}
                />
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SubAccountDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <SubAccountDrawer open={!!editing} account={editing} onClose={() => setEditing(null)} />
      <ArchiveSubAccountDialog
        name={archiving?.name ?? null}
        busy={busy}
        onCancel={() => setArchiving(null)}
        onConfirm={(typed) => {
          const target = archiving;
          if (!target) return;
          void act(() => subAccountsService.archive(target.id, typed), `${target.name} archived`).then(() => setArchiving(null));
        }}
      />
    </div>
  );
}
