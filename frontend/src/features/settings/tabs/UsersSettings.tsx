import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiAlertTriangle, FiEdit2, FiMail, FiSearch, FiShield, FiTrash2, FiUserCheck, FiUserPlus, FiUsers } from 'react-icons/fi';
import { Avatar, Badge, Button, EmptyState, IconButton, Input, Modal, Skeleton, StatTile, Switch } from '@/components/ui';
import { usersService, type AdminUser } from '@/services/usersService';
import { useAuthStore } from '@/stores/authStore';
import { can, isPermissionManaged } from '@/utils/access';
import { announceInvitation } from '@/utils/invitations';
import { extractErrorMessage } from '@/utils/errors';
import { hasRole } from '@/utils/roles';
import { SettingsSection } from '../components/SettingsSection';
import { accessSummary, UserDrawer } from './users/UserDrawer';
import { useAssignableAiRoles, usePermissionCatalog, useUsersList } from './users/useUsersData';
import styles from './UsersSettings.module.css';

type Filter = 'all' | 'active' | 'invited' | 'off' | 'attention';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'invited', label: 'Invited' },
  { id: 'off', label: 'Deactivated' },
  { id: 'attention', label: 'Needs attention' },
];

const ALL_ROLES = '';
const ADMINS = '__admins__';

function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Settings → Users: everyone in this business with their AI role, the account
 * type it gives them and how much they can use, and the way to add or change
 * people (UserDrawer). Owners and admins manage anyone but the owner; someone
 * given User Management manages only people whose access they have themselves.
 */
export function UsersSettings() {
  const me = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const { data: users, isLoading, error, refetch } = useUsersList();
  const { data: catalog } = usePermissionCatalog();
  const { data: aiRoles = [] } = useAssignableAiRoles();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [roleFilter, setRoleFilter] = useState(ALL_ROLES);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [deactivating, setDeactivating] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fullAdmin = hasRole(me, 'owner') || hasRole(me, 'admin');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  /** Whether the signed-in person may change this one at all (the server checks the same). */
  const manageable = (user: AdminUser): boolean => {
    if (user.linkedFromMain) return false;
    if (user.roles.includes('owner')) return user.id === me?.id;
    if (fullAdmin) return true;
    if (!isPermissionManaged(me) || user.id === me?.id || user.accessMode !== 'permissions') return false;
    return (user.permissions ?? []).every((p) => me?.permissions?.includes(p));
  };

  const list = useMemo(() => users ?? [], [users]);
  const counts = useMemo(
    () => ({
      total: list.length,
      active: list.filter((u) => u.active).length,
      invited: list.filter((u) => u.pendingInvitation).length,
      attention: list.filter((u) => u.needsAiRole).length,
    }),
    [list],
  );
  const roleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of list) if (u.aiRole && u.aiRole.status !== 'missing') seen.set(u.aiRole.slug, u.aiRole.name);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((u) => {
      if (q && !`${u.name} ${u.email} ${u.accountType ?? ''} ${u.aiRole?.name ?? ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'active' && !u.active) return false;
      if (filter === 'invited' && !u.pendingInvitation) return false;
      if (filter === 'off' && u.active) return false;
      if (filter === 'attention' && !u.needsAiRole) return false;
      if (roleFilter === ADMINS && u.accessMode !== 'full') return false;
      if (roleFilter && roleFilter !== ADMINS && u.aiRole?.slug !== roleFilter) return false;
      return true;
    });
  }, [list, search, filter, roleFilter]);

  const act = async (user: AdminUser, run: () => Promise<unknown>, done: string) => {
    setBusyId(user.id);
    try {
      await run();
      toast.success(done);
      refresh();
      return true;
    } catch (err) {
      toast.error(extractErrorMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const setActive = async (user: AdminUser, active: boolean) => {
    const ok = await act(user, () => usersService.update(user.id, { active }), active ? `${user.name} can sign in again` : `${user.name} was deactivated and signed out`);
    if (ok) setDeactivating(null);
  };

  // Says whether the email actually went; if not, why — and puts the link on the clipboard to send by hand.
  const resendInvitation = async (user: AdminUser) => {
    setBusyId(user.id);
    try {
      await announceInvitation(await usersService.resendInvitation(user.id), user.email);
      refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const user = deleting;
    if (!user) return;
    const ok = await act(user, () => usersService.remove(user.id), `${user.name} was deleted`);
    if (ok) setDeleting(null);
  };

  const ready = !!catalog;

  return (
    <div className={styles.page}>
      <div className={styles.tiles}>
        <StatTile icon={FiUsers} label="People" value={counts.total} active={filter === 'all'} onClick={() => setFilter('all')} />
        <StatTile icon={FiUserCheck} label="Active" value={counts.active} active={filter === 'active'} onClick={() => setFilter('active')} />
        <StatTile icon={FiMail} label="Invited" value={counts.invited} active={filter === 'invited'} onClick={() => setFilter('invited')} />
        <StatTile
          icon={FiAlertTriangle}
          label="Needs attention"
          value={counts.attention}
          active={filter === 'attention'}
          onClick={() => setFilter('attention')}
        />
      </div>

      <SettingsSection
        icon={<FiUsers />}
        title="People"
        description="Each person has their own sign-in and an AI role. The AI role is their AI agent and their account type; their access is set page by page."
      >
        <div className={styles.toolbar}>
          <div className={styles.toolbarRow}>
            <div className={styles.search}>
              <Input
                aria-label="Search people"
                placeholder="Search by name, email or AI role"
                leftIcon={<FiSearch />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select className={styles.select} aria-label="Filter by AI role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value={ALL_ROLES}>All AI roles</option>
              <option value={ADMINS}>Owner & administrators</option>
              {roleOptions.map(([slug, name]) => (
                <option key={slug} value={slug}>
                  {name}
                </option>
              ))}
            </select>
            {can(me, 'users', 'create') && (
              <Button type="button" leftIcon={<FiUserPlus />} disabled={!ready} onClick={() => setCreating(true)}>
                Create user
              </Button>
            )}
          </div>
          <div className={styles.filters} role="group" aria-label="Filter people">
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
          <div className={styles.rows} aria-busy="true">
            <Skeleton height={76} />
            <Skeleton height={76} />
            <Skeleton height={76} />
          </div>
        ) : error ? (
          <EmptyState
            compact
            icon={FiAlertTriangle}
            title="People couldn’t be loaded"
            description={extractErrorMessage(error)}
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={FiUsers}
            title={list.length === 0 ? 'No people yet' : 'Nobody matches'}
            description={list.length === 0 ? 'Create the first account with “Create user”.' : 'Try another search or filter.'}
          />
        ) : (
          <ul className={styles.rows}>
            {rows.map((user) => {
              const isOwner = user.roles.includes('owner');
              const isSelf = user.id === me?.id;
              const mayChange = manageable(user);
              const locked = isOwner || isSelf || !!user.linkedFromMain || !mayChange;
              const lockedReason = user.linkedFromMain
                ? 'This person has access through the Main Account, so it can only be changed from there'
                : isOwner
                  ? 'The owner’s account can’t be deactivated or deleted'
                  : isSelf
                    ? 'You can’t deactivate or delete your own account'
                    : 'Only an owner or admin can change this person';
              const role = user.aiRole;
              return (
                <li key={user.id} className={clsx(styles.row, !user.active && styles.rowOff)}>
                  <div className={styles.identity}>
                    <Avatar name={user.name} size="md" />
                    <span className={styles.identityText}>
                      <span className={styles.name}>
                        {user.name}
                        {isSelf && <span className={styles.you}> (you)</span>}
                      </span>
                      <span className={styles.meta}>{user.email}</span>
                    </span>
                  </div>

                  <div className={styles.roleBlock}>
                    <span className={styles.badges}>
                      <Badge variant={isOwner ? 'warning' : user.accessMode === 'full' ? 'info' : user.needsAiRole ? 'warning' : 'accent'}>
                        {user.accountType ?? '—'}
                      </Badge>
                      {user.linkedFromMain && <Badge variant="info">Main Account</Badge>}
                      {user.pendingInvitation && <Badge variant="warning">Invited</Badge>}
                      {!user.active && <Badge variant="danger">Deactivated</Badge>}
                      {user.aiAccessEnabled === false && <Badge variant="warning">AI off</Badge>}
                    </span>
                    <span className={styles.agent}>
                      {user.accessMode === 'full' ? (
                        <>
                          <FiShield aria-hidden /> Every agent
                        </>
                      ) : role ? (
                        <>
                          <span className={styles.agentDot} style={{ background: role.avatarColor ?? 'var(--color-text-muted)' }} aria-hidden />
                          {role.status === 'missing' ? 'AI role removed' : role.name}
                          {role.status === 'draft' && ' (draft)'}
                        </>
                      ) : (
                        'No AI role'
                      )}
                    </span>
                    {user.needsAiRole && <span className={styles.attention}>Needs a new AI role</span>}
                  </div>

                  <dl className={styles.facts}>
                    <div>
                      <dt>Access</dt>
                      <dd>{accessSummary(user, catalog)}</dd>
                    </div>
                    <div>
                      <dt>Added</dt>
                      <dd>{formatDate(user.createdAt)}</dd>
                    </div>
                  </dl>

                  <div className={styles.actions}>
                    {user.pendingInvitation && mayChange && !isOwner && (
                      <Button type="button" variant="ghost" size="sm" disabled={busyId === user.id} onClick={() => void resendInvitation(user)}>
                        Resend invite
                      </Button>
                    )}
                    <span title={locked ? lockedReason : user.active ? 'Deactivate — they can no longer sign in' : 'Reactivate'}>
                      <Switch
                        checked={user.active}
                        disabled={locked || busyId === user.id || !can(me, 'users', 'edit')}
                        ariaLabel={`${user.name} can sign in`}
                        onChange={(checked) => (checked ? void setActive(user, true) : setDeactivating(user))}
                      />
                    </span>
                    <IconButton
                      icon={<FiEdit2 />}
                      label={mayChange ? `Edit ${user.name}` : lockedReason}
                      title={mayChange ? `Edit ${user.name}` : lockedReason}
                      size="sm"
                      disabled={!mayChange || !ready || !can(me, 'users', 'edit')}
                      onClick={() => setEditing(user)}
                    />
                    {can(me, 'users', 'delete') && (
                      <IconButton
                        icon={<FiTrash2 />}
                        label={locked ? lockedReason : `Delete ${user.name}`}
                        title={locked ? lockedReason : `Delete ${user.name}`}
                        size="sm"
                        disabled={locked || busyId === user.id}
                        onClick={() => setDeleting(user)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      {catalog && (
        <>
          <UserDrawer open={creating} onClose={() => setCreating(false)} catalog={catalog} aiRoles={aiRoles} me={me} onSaved={refresh} />
          <UserDrawer open={!!editing} user={editing} onClose={() => setEditing(null)} catalog={catalog} aiRoles={aiRoles} me={me} onSaved={refresh} />
        </>
      )}

      <Modal open={!!deactivating} onClose={() => setDeactivating(null)} title="Deactivate user" maxWidth={440}>
        <div className={styles.modalBody}>
          <p>
            Deactivate <strong>{deactivating?.name}</strong>? They are signed out everywhere and can’t sign in until you reactivate them. Their
            data is kept.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setDeactivating(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={!!deactivating && busyId === deactivating.id}
            onClick={() => deactivating && void setActive(deactivating, false)}
          >
            Deactivate
          </Button>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete user" maxWidth={440}>
        <div className={styles.modalBody}>
          <p>
            Delete <strong>{deleting?.name}</strong> ({deleting?.email})? Their account is removed for good. To only stop them signing in,
            deactivate them instead.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" loading={!!deleting && busyId === deleting.id} onClick={() => void remove()}>
            Delete user
          </Button>
        </div>
      </Modal>
    </div>
  );
}
