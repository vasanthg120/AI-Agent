import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiArrowLeft, FiEdit2, FiGrid, FiLogIn, FiPauseCircle, FiPlayCircle, FiRefreshCw, FiSend, FiTrash2, FiX } from 'react-icons/fi';
import { Badge, Button, CopyableText, EmptyState, IconButton, Skeleton, StatTile, Tabs } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { SettingsSection } from '@/features/settings/components/SettingsSection';
import { subAccountsService, type SubAccountDetails } from '@/services/subAccountsService';
import { useAuthStore } from '@/stores/authStore';
import { formatCurrency } from '@/utils/currency';
import { extractErrorMessage } from '@/utils/errors';
import { ArchiveSubAccountDialog } from './ArchiveSubAccountDialog';
import { SubAccountDrawer } from './SubAccountDrawer';
import { AccountLogo, AccountStatusBadge, SubscriptionBadge, formatDate, formatDateTime, formatPrice } from './subAccountParts';
import { ACCOUNTS_QUERY_KEY } from './useAccounts';
import styles from './SubAccountDetailPage.module.css';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users & Permissions' },
  { id: 'billing', label: 'Subscription & Billing' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'activity', label: 'Activity & Audit Logs' },
];

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  consultant: 'Consultant',
  agent_user: 'Team member',
  user: 'User',
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children || '—'}</dd>
    </div>
  );
}

function humanize(value: string): string {
  const text = value.replace(/[_.]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function SubAccountDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const { data: account, isLoading, error } = useQuery({
    queryKey: ['sub-accounts', id],
    queryFn: () => subAccountsService.details(id),
    retry: false,
  });

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

  const enter = async (destination?: string) => {
    try {
      await switchAccount(id, destination);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  if (isLoading) return <Skeleton height={360} />;
  if (error || !account) {
    return (
      <EmptyState
        icon={FiGrid}
        title="Sub-account not found"
        description={error ? extractErrorMessage(error) : undefined}
        action={
          <Button type="button" variant="secondary" onClick={() => navigate(ROUTES.settingsSubAccounts)}>
            Back to sub-accounts
          </Button>
        }
      />
    );
  }

  const open = account.status === 'active';
  const pendingOwner = !!account.owner && !account.owner.activated;

  return (
    <div className={styles.page}>
      <Link to={ROUTES.settingsSubAccounts} className={styles.back}>
        <FiArrowLeft aria-hidden /> All sub-accounts
      </Link>

      <header className={styles.header}>
        <AccountLogo name={account.name} logo={account.profile.logo} size="lg" />
        <div className={styles.headerText}>
          <h1 className={styles.title}>{account.name}</h1>
          <span className={styles.badges}>
            <AccountStatusBadge status={account.status} />
            <SubscriptionBadge status={account.billing.status} />
          </span>
        </div>
        <div className={styles.headerActions}>
          {open && (
            <Button type="button" size="sm" leftIcon={<FiLogIn />} onClick={() => void enter()}>
              Switch to account
            </Button>
          )}
          {account.status !== 'archived' && (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiEdit2 />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {open && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              leftIcon={<FiPauseCircle />}
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Suspend ${account.name}? Nobody can sign in to it until you reactivate it.`)) {
                  void act(() => subAccountsService.setStatus(id, 'suspended'), `${account.name} suspended`);
                }
              }}
            >
              Suspend
            </Button>
          )}
          {account.status === 'suspended' && account.suspendedByParent && (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiPlayCircle />} disabled={busy} onClick={() => void act(() => subAccountsService.setStatus(id, 'active'), `${account.name} reactivated`)}>
              Reactivate
            </Button>
          )}
          {account.status === 'archived' && (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiRefreshCw />} disabled={busy} onClick={() => void act(() => subAccountsService.restore(id), `${account.name} restored`)}>
              Restore
            </Button>
          )}
          {account.status !== 'archived' && (account.suspendedByParent || open) && (
            <Button type="button" size="sm" variant="ghost" leftIcon={<FiTrash2 />} disabled={busy} onClick={() => setArchiving(true)}>
              Delete
            </Button>
          )}
        </div>
      </header>

      {account.status === 'suspended' && !account.suspendedByParent && (
        <p className={styles.notice}>HaiVE support has suspended this account. Contact them to restore it.</p>
      )}

      <div className={styles.tabs}>
        <Tabs items={TABS} activeId={tab} onChange={setTab} />
      </div>

      {tab === 'overview' && (
        <OverviewTab
          account={account}
          pendingOwner={pendingOwner}
          inviteLink={inviteLink}
          busy={busy}
          onResend={() =>
            void act(async () => {
              const result = await subAccountsService.resendInvitation(id);
              setInviteLink(result.activationLink ?? null);
            }, 'Invitation sent')
          }
        />
      )}
      {tab === 'users' && <UsersTab id={id} canEnter={open} onEnter={() => void enter(ROUTES.settingsUsers)} />}
      {tab === 'billing' && <BillingTab id={id} canEnter={open} onEnter={() => void enter(ROUTES.billing)} />}
      {tab === 'integrations' && <IntegrationsTab id={id} />}
      {tab === 'activity' && <ActivityTab id={id} />}

      <SubAccountDrawer open={editing} account={account} onClose={() => setEditing(false)} />
      <ArchiveSubAccountDialog
        name={archiving ? account.name : null}
        busy={busy}
        onCancel={() => setArchiving(false)}
        onConfirm={(typed) => void act(() => subAccountsService.archive(id, typed), `${account.name} archived`).then(() => setArchiving(false))}
      />
    </div>
  );
}

function OverviewTab({ account, pendingOwner, inviteLink, busy, onResend }: { account: SubAccountDetails; pendingOwner: boolean; inviteLink: string | null; busy: boolean; onResend: () => void }) {
  const { profile, billing } = account;
  const address = [profile.address, profile.city, profile.state, profile.postalCode].filter(Boolean).join(', ');
  return (
    <div className={styles.stack}>
      <SettingsSection title="Business information">
        <dl className={styles.facts}>
          <Fact label="Business email">{profile.businessEmail}</Fact>
          <Fact label="Phone">{profile.phone ? `${profile.phoneCountryCode ?? ''} ${profile.phone}` : ''}</Fact>
          <Fact label="Website">{profile.website}</Fact>
          <Fact label="Address">{address}</Fact>
          <Fact label="Time zone">{account.timezone}</Fact>
          <Fact label="Currency">{account.currency}</Fact>
          <Fact label="Created">{formatDate(account.createdAt)}</Fact>
          <Fact label="Last active">{formatDateTime(account.lastActiveAt)}</Fact>
          <Fact label="Account ID">
            <code className={styles.code}>{account.id}</code>
          </Fact>
        </dl>
      </SettingsSection>
      <SettingsSection
        title="Account owner"
        actions={
          pendingOwner && account.status === 'active' ? (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiSend />} disabled={busy} onClick={onResend}>
              Resend invitation
            </Button>
          ) : undefined
        }
      >
        {account.owner ? (
          <dl className={styles.facts}>
            <Fact label="Name">{account.owner.name}</Fact>
            <Fact label="Login email">{account.owner.email}</Fact>
            <Fact label="Status">{account.owner.activated ? <Badge variant="success">Activated</Badge> : <Badge variant="warning">Invited, not yet activated</Badge>}</Fact>
          </dl>
        ) : (
          <p className={styles.muted}>No owner yet.</p>
        )}
        {inviteLink && (
          <div className={styles.inviteLink}>
            <CopyableText value={inviteLink} />
            <span className={styles.muted}>Works once, for 7 days. Share it yourself if the email doesn’t arrive.</span>
          </div>
        )}
      </SettingsSection>
      <SettingsSection title="Subscription">
        <dl className={styles.facts}>
          <Fact label="Current plan">{billing.planName ?? 'No plan'}</Fact>
          <Fact label="Status">
            <SubscriptionBadge status={billing.status} />
          </Fact>
          <Fact label="Billing amount">{formatPrice(billing)}</Fact>
          <Fact label={billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'}>{formatDate(billing.renewsAt)}</Fact>
        </dl>
      </SettingsSection>
    </div>
  );
}

function UsersTab({ id, canEnter, onEnter }: { id: string; canEnter: boolean; onEnter: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['sub-accounts', id, 'users'], queryFn: () => subAccountsService.users(id) });
  const { data: employees } = useQuery({ queryKey: ['sub-accounts', id, 'grantable'], queryFn: () => subAccountsService.grantableEmployees(id) });
  const [grantee, setGrantee] = useState('');
  const [role, setRole] = useState<'admin' | 'manager'>('admin');
  const [saving, setSaving] = useState(false);

  const change = async (work: () => Promise<unknown>, done: string) => {
    setSaving(true);
    try {
      await work();
      toast.success(done);
      setGrantee('');
      await queryClient.invalidateQueries({ queryKey: ['sub-accounts', id] });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <Skeleton height={240} />;
  if (error || !data) return <p className={styles.errorText}>{extractErrorMessage(error)}</p>;

  return (
    <div className={styles.stack}>
      <div className={styles.tiles}>
        <StatTile label="Total users" value={data.total} />
        <StatTile label="Active" value={data.active} />
        <StatTile label="Pending invitations" value={data.pendingInvitations} />
      </div>
      <SettingsSection
        title="This business’s people"
        description="Add, remove and change people from inside the account."
        actions={
          canEnter ? (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiLogIn />} onClick={onEnter}>
              Manage users
            </Button>
          ) : undefined
        }
      >
        <ul className={styles.list}>
          {data.people.map((person) => (
            <li key={person.id} className={styles.listRow}>
              <span className={styles.listMain}>
                <strong>{person.name}</strong>
                <span className={styles.muted}>{person.email}</span>
              </span>
              <span className={styles.badges}>
                {person.roles
                  .filter((r) => !(r === 'admin' && person.roles.includes('owner')))
                  .map((r) => (
                    <Badge key={r} variant="neutral">
                      {ROLE_LABEL[r] ?? r}
                    </Badge>
                  ))}
                {person.pendingInvitation && <Badge variant="warning">Invited</Badge>}
                {!person.active && <Badge variant="danger">Deactivated</Badge>}
              </span>
              <span className={styles.muted}>Last active {formatDate(person.lastActiveAt)}</span>
            </li>
          ))}
        </ul>
      </SettingsSection>
      <SettingsSection title="Access from your Main Account" description="Your employees can’t enter this account unless you give them access here.">
        <ul className={styles.list}>
          {data.mainAccountAccess.map((person) => (
            <li key={person.loginUserId} className={styles.listRow}>
              <span className={styles.listMain}>
                <strong>{person.name}</strong>
                <span className={styles.muted}>{person.email}</span>
              </span>
              <span className={styles.badges}>
                {person.isMainOwner && <Badge variant="accent">Main Account owner</Badge>}
                {person.roles.map((r) => (
                  <Badge key={r} variant="neutral">
                    {ROLE_LABEL[r] ?? r}
                  </Badge>
                ))}
              </span>
              {!person.isMainOwner && (
                <IconButton
                  icon={<FiX />}
                  label={`Remove ${person.name}’s access`}
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    if (window.confirm(`Remove ${person.name}’s access to this account?`)) {
                      void change(() => subAccountsService.removeAccess(id, person.loginUserId), 'Access removed');
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        {!!employees?.length && (
          <form
            className={styles.grant}
            onSubmit={(e) => {
              e.preventDefault();
              if (grantee) void change(() => subAccountsService.grantAccess(id, grantee, role), 'Access granted');
            }}
          >
            <select className={styles.select} aria-label="Employee" value={grantee} onChange={(e) => setGrantee(e.target.value)}>
              <option value="">Choose an employee…</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name} ({employee.email})
                </option>
              ))}
            </select>
            <select className={styles.select} aria-label="Role in this account" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'manager')}>
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
            </select>
            <Button type="submit" variant="secondary" disabled={!grantee} loading={saving}>
              Give access
            </Button>
          </form>
        )}
      </SettingsSection>
    </div>
  );
}

function BillingTab({ id, canEnter, onEnter }: { id: string; canEnter: boolean; onEnter: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['sub-accounts', id, 'billing'], queryFn: () => subAccountsService.billing(id) });
  if (isLoading) return <Skeleton height={240} />;
  if (error || !data) return <p className={styles.errorText}>{extractErrorMessage(error)}</p>;
  const { subscription } = data;
  return (
    <div className={styles.stack}>
      <SettingsSection
        title="Current subscription"
        description="This account pays for itself. Upgrades, downgrades and payment methods are managed from inside it."
        actions={
          canEnter ? (
            <Button type="button" size="sm" variant="secondary" leftIcon={<FiLogIn />} onClick={onEnter}>
              Manage subscription
            </Button>
          ) : undefined
        }
      >
        <dl className={styles.facts}>
          <Fact label="Plan">{subscription.planName ?? 'No plan'}</Fact>
          <Fact label="Status">
            <SubscriptionBadge status={subscription.status} />
          </Fact>
          <Fact label="Billing">{formatPrice(subscription)}</Fact>
          <Fact label={subscription.cancelAtPeriodEnd ? 'Ends' : 'Upcoming renewal'}>{formatDate(subscription.renewsAt)}</Fact>
          <Fact label="Failed renewals">{subscription.failedRenewals > 0 ? subscription.failedRenewals : 'None'}</Fact>
          <Fact label="Payment method">
            {data.paymentMethods.find((m) => m.isDefault)
              ? `${data.paymentMethods.find((m) => m.isDefault)?.cardNetwork ?? 'Card'} ending ${data.paymentMethods.find((m) => m.isDefault)?.last4 ?? ''}`
              : 'None saved'}
          </Fact>
        </dl>
      </SettingsSection>
      <SettingsSection title="Payment history">
        {data.payments.length === 0 ? (
          <p className={styles.muted}>No payments yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.payments.map((payment) => (
              <li key={payment.id} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{formatCurrency(payment.amount, payment.currency)}</strong>
                  <span className={styles.muted}>{humanize(payment.type)}</span>
                </span>
                <Badge variant={payment.status === 'captured' ? 'success' : payment.status === 'failed' ? 'danger' : 'neutral'}>{humanize(payment.status)}</Badge>
                <span className={styles.muted}>{formatDate(payment.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Invoices">
        {data.invoices.length === 0 ? (
          <p className={styles.muted}>No invoices yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.invoices.map((invoice) => (
              <li key={invoice.id} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{invoice.number}</strong>
                  <span className={styles.muted}>{formatCurrency(invoice.total, invoice.currency)}</span>
                </span>
                <Badge variant={invoice.status === 'paid' ? 'success' : 'neutral'}>{humanize(invoice.status)}</Badge>
                <span className={styles.muted}>{formatDate(invoice.issuedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}

function IntegrationsTab({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['sub-accounts', id, 'integrations'], queryFn: () => subAccountsService.integrations(id) });
  if (isLoading) return <Skeleton height={200} />;
  if (error || !data) return <p className={styles.errorText}>{extractErrorMessage(error)}</p>;
  return (
    <div className={styles.stack}>
      <SettingsSection title="Connected CRM">
        {data.crms.length === 0 ? (
          <p className={styles.muted}>No CRM connected.</p>
        ) : (
          <ul className={styles.list}>
            {data.crms.map((crm) => (
              <li key={`${crm.provider}-${crm.label}`} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{crm.label}</strong>
                  <span className={styles.muted}>{humanize(crm.provider)}</span>
                </span>
                <Badge variant={crm.status === 'active' ? 'success' : 'neutral'}>{humanize(crm.status)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Email and files">
        <dl className={styles.facts}>
          <Fact label="Outlook mailboxes">{data.outlook.connected}</Fact>
          <Fact label="Mailboxes needing reconnection">{data.outlook.needingReconnection}</Fact>
          <Fact label="Cloud storage">{data.cloud.length ? data.cloud.map((c) => humanize(c.provider)).join(', ') : 'None'}</Fact>
        </dl>
      </SettingsSection>
      <SettingsSection title="API connections">
        {data.connections.length === 0 ? (
          <p className={styles.muted}>None connected.</p>
        ) : (
          <ul className={styles.list}>
            {data.connections.map((connection) => (
              <li key={connection.provider} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{humanize(connection.provider)}</strong>
                </span>
                <span className={styles.muted}>Updated {formatDate(connection.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}

function ActivityTab({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['sub-accounts', id, 'activity'], queryFn: () => subAccountsService.activity(id) });
  if (isLoading) return <Skeleton height={200} />;
  if (error || !data) return <p className={styles.errorText}>{extractErrorMessage(error)}</p>;
  return (
    <div className={styles.stack}>
      <SettingsSection title="Sign-ins" description="The devices people are signed in on, most recent first.">
        {data.logins.length === 0 ? (
          <p className={styles.muted}>Nobody has signed in yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.logins.map((login, index) => (
              <li key={`${login.name}-${index}`} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{login.name}</strong>
                  <span className={styles.muted}>{login.device}</span>
                </span>
                <span className={styles.muted}>{formatDateTime(login.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Subscription changes">
        {data.subscriptionEvents.length === 0 ? (
          <p className={styles.muted}>No subscription changes yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.subscriptionEvents.map((event) => (
              <li key={event.id} className={styles.listRow}>
                <span className={styles.listMain}>{humanize(event.type)}</span>
                <span className={styles.muted}>{formatDateTime(event.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Account changes" description="Who changed what, newest first.">
        {data.changes.length === 0 ? (
          <p className={styles.muted}>No changes yet.</p>
        ) : (
          <ul className={styles.list}>
            {data.changes.map((change) => (
              <li key={change.id} className={styles.listRow}>
                <span className={styles.listMain}>
                  <strong>{change.who}</strong>
                  <span className={styles.muted}>{change.what}</span>
                </span>
                <span className={styles.muted}>{formatDateTime(change.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
