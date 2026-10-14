import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiShield, FiTrash2, FiUserPlus, FiUsers } from 'react-icons/fi';
import { Badge, Button, CopyableText, EmptyState, IconButton, Input, Modal, Skeleton, Switch } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { APP_FEATURES, BASIC_FEATURES_TEXT, DEFAULT_ROLE_FEATURES } from '@/utils/access';
import { ROUTES } from '@/constants/routes';
import { agentRolesService, type AgentRole } from '@/services/agentRolesService';
import { organizationsService, type Store } from '@/services/organizationsService';
import { useAuthStore } from '@/stores/authStore';
import { usersService, type AdminUser, type AssignableRole, type CreateUserResult } from '@/services/usersService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './UsersSettings.module.css';

const ROLE_BADGE: Record<string, 'info' | 'accent' | 'neutral' | 'success' | 'warning'> = {
  owner: 'warning',
  admin: 'info',
  agent_user: 'accent',
  user: 'neutral',
  manager: 'success',
  consultant: 'success',
};

// What each role can reach. Enforced by the server on every request (the
// routes' own role checks) — this text describes those checks, it isn't what
// applies them.
const ROLES: { id: AssignableRole | 'owner'; label: string; summary: string; can: string[]; cannot: string[] }[] = [
  {
    id: 'owner',
    label: 'Owner',
    summary:
      'The person who created the organization. Everything an Admin can do; can’t be changed or removed by anyone else.',
    can: ['Everything in the workspace', 'Billing and credits', 'Users, AI agents, integrations and all settings'],
    cannot: [],
  },
  {
    id: 'admin',
    label: 'Admin',
    summary: 'Runs the workspace.',
    can: [
      'Every dashboard, Finance, Reporting, Business Knowledge, Customers',
      'Create and manage users and AI agents',
      'Connect integrations and change settings',
    ],
    cannot: ['Change or remove the Owner'],
  },
  {
    id: 'agent_user',
    label: 'Team member',
    summary: 'Works with one AI role. What they can use is set by that AI role.',
    can: [
      'Chat with the AI agent of their AI role',
      'Dashboard, Timeline, To-Do and EOD',
      'Whatever else their AI role includes (AI Email Inbox, Call Copilot, Customers, Business Knowledge)',
    ],
    cannot: ['Billing, Finance and Reporting', 'Users, AI roles, integrations and other settings'],
  },
  {
    id: 'manager',
    label: 'Manager',
    summary: 'Leads one store.',
    can: [
      'Their own store’s dashboards and team',
      'Business Knowledge, Customers, Reporting',
      'AI chat, AI Email Inbox, Call Copilot',
    ],
    cannot: ['Other stores’ data', 'Finance', 'Users, AI agents, integrations'],
  },
  {
    id: 'consultant',
    label: 'Consultant',
    summary: 'A salesperson in one store.',
    can: [
      'Their personal dashboard and My Customer Activity',
      'AI chat, their own AI Email Inbox, Call Copilot',
      'To-do and EOD reports',
    ],
    cannot: ['Other people’s data', 'Finance, Reporting, Business Knowledge, Customers', 'Any admin settings'],
  },
  {
    id: 'user',
    label: 'Standard user',
    summary: 'A general account, not tied to a store.',
    can: ['Dashboard and Timeline', 'AI chat, their own AI Email Inbox, Call Copilot', 'To-do and EOD reports'],
    cannot: ['Finance, Reporting, Business Knowledge, Customers', 'Any admin settings'],
  },
];
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label])) as Record<string, string>;
// The two kinds of account most workspaces need. Manager / Consultant only
// make sense once the organization has stores, and "Standard user" is kept
// only for accounts that already have it.
const MAIN_TYPES: AssignableRole[] = ['agent_user', 'admin'];
const TYPE_OPTION_LABEL: Record<string, string> = {
  agent_user: 'Team member — works with an AI role',
  admin: 'Admin — manages the workspace',
  manager: 'Manager — leads one store',
  consultant: 'Consultant — a salesperson in one store',
  user: 'Standard user (no AI role)',
};

// Manager/Consultant dashboards are store-scoped — a store is required for
// both (the server checks it belongs to this organization).
const STORE_SCOPED_ROLES = new Set<string>(['manager', 'consultant']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserForm {
  email: string;
  name: string;
  role: AssignableRole;
  assignedAgentId: string;
  storeId: string;
  department: string;
  aiAccessEnabled: boolean;
  voiceAccessEnabled: boolean;
}

const emptyForm: UserForm = {
  email: '',
  name: '',
  // The normal case: a person who works with one of the AI roles.
  role: 'agent_user',
  assignedAgentId: '',
  storeId: '',
  department: '',
  aiAccessEnabled: true,
  voiceAccessEnabled: true,
};

/** What's still wrong with the form, in the user's words — null when it can be submitted. */
function problemWith(form: UserForm, mode: 'create' | 'edit', agents: AgentRole[], stores: Store[]): string | null {
  if (!form.name.trim()) return 'Enter the person’s name.';
  if (mode === 'create') {
    if (!form.email.trim()) return 'Enter their email address.';
    if (!EMAIL_PATTERN.test(form.email.trim())) return 'That email address doesn’t look right.';
  }
  if (form.role === 'agent_user') {
    if (agents.length === 0)
      return 'There are no active AI roles yet — create and activate one under Settings → AI Roles first.';
    if (!form.assignedAgentId) return 'Choose the AI role for this person.';
  }
  if (STORE_SCOPED_ROLES.has(form.role)) {
    if (stores.length === 0) return 'This organization has no stores yet — add one first, or pick another role.';
    if (!form.storeId) return 'Choose the store this person belongs to.';
  }
  return null;
}

export function UsersSettings() {
  const currentUserId = useAuthStore((state) => state.user?.id);
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [agentRoles, setAgentRoles] = useState<AgentRole[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreateUserResult | null>(null);

  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<UserForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<AdminUser | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);

  const load = async () => {
    // Only the first load shows the loading state; a refresh after a change keeps
    // the current list on screen until the new one arrives (no flash).
    if (users.length === 0) setLoading(true);
    // Each list on its own: the agent or store list failing must not take the
    // user list down with it (it used to — one failure emptied the whole page).
    const [userList, roleList, storeList] = await Promise.allSettled([
      usersService.list(),
      agentRolesService.list(),
      organizationsService.listStores(),
    ]);
    if (userList.status === 'fulfilled') {
      setUsers(userList.value);
      setLoadError(null);
    } else {
      setLoadError(extractErrorMessage(userList.reason));
    }
    if (roleList.status === 'fulfilled') setAgentRoles(roleList.value);
    else toast.error(`AI agents couldn’t be loaded: ${extractErrorMessage(roleList.reason)}`);
    if (storeList.status === 'fulfilled') setStores(storeList.value);
    else toast.error(`Stores couldn’t be loaded: ${extractErrorMessage(storeList.reason)}`);
    setLoading(false);
  };

  // Agent User accounts lock to one org-created agent (see backend's
  // resolveValidAgentIds) — built-in personas and drafts aren't assignable,
  // so this dropdown only ever offers the agents someone actually created
  // and activated.
  const createdAgents = agentRoles.filter((role) => !role.builtin && role.status === 'active');

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    // With exactly one AI role (or one store) there is nothing to choose.
    setForm({
      ...emptyForm,
      assignedAgentId: createdAgents.length === 1 ? createdAgents[0].slug : '',
      storeId: stores.length === 1 ? stores[0]._id : '',
    });
    setCreatedResult(null);
    setCreateOpen(true);
  };

  const closeCreateModal = () => {
    setCreateOpen(false);
    setForm(emptyForm);
    setCreatedResult(null);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await usersService.create({
        email: form.email.trim(),
        name: form.name.trim(),
        role: form.role,
        assignedAgentId: form.role === 'agent_user' ? form.assignedAgentId : undefined,
        storeId: STORE_SCOPED_ROLES.has(form.role) ? form.storeId : undefined,
        department: form.department.trim() || undefined,
        aiAccessEnabled: form.aiAccessEnabled,
        voiceAccessEnabled: form.voiceAccessEnabled,
      });
      setCreatedResult(result);
      toast.success(`${result.user.name} was created`);
      await load();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setCreating(false);
    }
  };

  const setActive = async (user: AdminUser, active: boolean) => {
    setBusyUserId(user.id);
    try {
      const updated = await usersService.update(user.id, { active });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success(active ? `${user.name} can sign in again` : `${user.name} was deactivated and signed out`);
      setDeactivatingUser(null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusyUserId(null);
    }
  };

  const openEdit = (user: AdminUser) => {
    setEditingUser(user);
    setEditForm({
      email: user.email,
      name: user.name,
      role: (user.roles.find((r) => r !== 'owner') as AssignableRole) ?? 'user',
      assignedAgentId: user.assignedAgentId ?? '',
      storeId: user.storeId ?? (stores.length === 1 ? stores[0]._id : ''),
      department: user.department ?? '',
      aiAccessEnabled: user.aiAccessEnabled !== false,
      voiceAccessEnabled: user.voiceAccessEnabled !== false,
    });
  };

  const handleEditSave = async () => {
    if (!editingUser) return;
    const isOwner = editingUser.roles.includes('owner');
    setSaving(true);
    try {
      const updated = await usersService.update(editingUser.id, {
        name: editForm.name.trim(),
        department: editForm.department.trim(),
        aiAccessEnabled: editForm.aiAccessEnabled,
        voiceAccessEnabled: editForm.voiceAccessEnabled,
        // The owner's role can't change (the server refuses it), so it isn't sent.
        ...(isOwner
          ? {}
          : {
              role: editForm.role,
              assignedAgentId: editForm.role === 'agent_user' ? editForm.assignedAgentId : undefined,
              storeId: STORE_SCOPED_ROLES.has(editForm.role) ? editForm.storeId : undefined,
            }),
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success('User updated');
      setEditingUser(null);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingUser) return;
    setBusyUserId(deletingUser.id);
    try {
      await usersService.remove(deletingUser.id);
      setUsers((prev) => prev.filter((u) => u.id !== deletingUser.id));
      toast.success(`${deletingUser.name} was deleted`);
      setDeletingUser(null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusyUserId(null);
    }
  };

  // Falls back to a readable placeholder, never the raw id — an
  // agent/store that's since been deleted shouldn't surface its Mongo id.
  const agentName = (agentId?: string) => agentRoles.find((a) => a.slug === agentId)?.name ?? 'AI role removed';
  const storeName = (storeId?: string) => stores.find((s) => s._id === storeId)?.name ?? 'Unknown store';

  const createProblem = problemWith(form, 'create', createdAgents, stores);
  const editingOwner = !!editingUser?.roles.includes('owner');
  const editProblem = editingUser
    ? problemWith(editingOwner ? { ...editForm, role: 'user' } : editForm, 'edit', createdAgents, stores)
    : null;

  // Which account types the dialog offers: the two main ones, the store-based
  // ones once the organization has stores, and whatever the account already is.
  const typeOptions = (current: AssignableRole): AssignableRole[] => {
    const options: AssignableRole[] = [...MAIN_TYPES];
    if (stores.length > 0) options.push('manager', 'consultant');
    if (!options.includes(current)) options.push(current);
    return options;
  };

  // Account type, plus what that type needs — shared by the create and edit dialogs.
  const roleFields = (value: UserForm, onChange: (next: UserForm) => void) => {
    const role = ROLES.find((r) => r.id === value.role);
    const aiRole = createdAgents.find((a) => a.slug === value.assignedAgentId);
    const aiRoleFeatures = aiRole?.features ?? DEFAULT_ROLE_FEATURES;
    return (
      <>
        <SettingsField label="Account type" hint={value.role === 'agent_user' ? undefined : role?.summary}>
          <select
            className={styles.select}
            value={value.role}
            onChange={(e) => {
              const next = e.target.value as AssignableRole;
              onChange({
                ...value,
                role: next,
                assignedAgentId: value.assignedAgentId || (createdAgents.length === 1 ? createdAgents[0].slug : ''),
                storeId: value.storeId || (stores.length === 1 ? stores[0]._id : ''),
              });
            }}
          >
            {typeOptions(value.role).map((id) => (
              <option key={id} value={id}>
                {TYPE_OPTION_LABEL[id] ?? id}
              </option>
            ))}
          </select>
        </SettingsField>

        {value.role === 'agent_user' &&
          (createdAgents.length === 0 ? (
            <div className={styles.formProblem}>
              There are no active AI roles yet. Create one and activate it, then come back to add this person.{' '}
              <Button type="button" variant="secondary" size="sm" onClick={() => navigate(ROUTES.settingsAgentRoles)}>
                Go to AI Roles
              </Button>
            </div>
          ) : (
            <SettingsField
              label="AI role"
              hint="The AI agent this person works with. It also decides what they can use."
            >
              <select
                className={styles.select}
                value={value.assignedAgentId}
                onChange={(e) => onChange({ ...value, assignedAgentId: e.target.value })}
              >
                <option value="" disabled>
                  Select an AI role…
                </option>
                {createdAgents.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
              {aiRole && (
                <ul className={styles.permissionList}>
                  <li className={styles.permissionCan}>{BASIC_FEATURES_TEXT}</li>
                  {APP_FEATURES.map((feature) => (
                    <li
                      key={feature.id}
                      className={aiRoleFeatures.includes(feature.id) ? styles.permissionCan : styles.permissionCannot}
                    >
                      {feature.label}
                    </li>
                  ))}
                </ul>
              )}
            </SettingsField>
          ))}

        {value.role !== 'agent_user' && role && (
          <ul className={styles.permissionList}>
            {role.can.map((line) => (
              <li key={line} className={styles.permissionCan}>
                {line}
              </li>
            ))}
            {role.cannot.map((line) => (
              <li key={line} className={styles.permissionCannot}>
                {line}
              </li>
            ))}
          </ul>
        )}

        {STORE_SCOPED_ROLES.has(value.role) && (
          <SettingsField label="Store" hint="They only see this store’s data.">
            <select
              className={styles.select}
              value={value.storeId}
              disabled={stores.length === 0}
              onChange={(e) => onChange({ ...value, storeId: e.target.value })}
            >
              <option value="" disabled>
                {stores.length === 0 ? 'No stores yet' : 'Select a store…'}
              </option>
              {stores.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
          </SettingsField>
        )}
      </>
    );
  };

  const accessFields = (value: UserForm, onChange: (next: UserForm) => void) => (
    <>
      <SettingsField
        label="AI access"
        hint="Lets this person use AI features (chat, analysis) on the organization’s credits. Off blocks every AI request from this account."
      >
        <Switch
          checked={value.aiAccessEnabled}
          ariaLabel="AI access"
          onChange={(checked) => onChange({ ...value, aiAccessEnabled: checked })}
        />
      </SettingsField>
      <SettingsField
        label="Voice AI access"
        hint="Only the voice (speech-to-text / text-to-speech) feature — text chat is controlled by AI access above."
      >
        <Switch
          checked={value.voiceAccessEnabled}
          ariaLabel="Voice AI access"
          onChange={(checked) => onChange({ ...value, voiceAccessEnabled: checked })}
        />
      </SettingsField>
    </>
  );

  return (
    <>
      <SettingsSection
        icon={<FiUserPlus />}
        title="Create a New User"
        description="Give a person their own sign-in and one of your AI roles. The AI role decides which AI agent they work with and what they can use."
        footer={
          <>
            <Button type="button" variant="ghost" leftIcon={<FiShield />} onClick={() => setRolesOpen(true)}>
              Account types
            </Button>
            <Button type="button" leftIcon={<FiUserPlus />} onClick={openCreate}>
              Create User
            </Button>
          </>
        }
      >
        <p>
          Create the AI role first (Settings → AI Roles), then add the person here and pick that role. They get a
          temporary password, shown once, to sign in with.
        </p>
      </SettingsSection>

      <SettingsSection icon={<FiUsers />} title="Existing Users" description="All accounts in this workspace.">
        {loading ? (
          <div className={styles.userList} aria-busy="true">
            <Skeleton height={64} />
            <Skeleton height={64} />
            <Skeleton height={64} />
          </div>
        ) : loadError ? (
          <EmptyState
            compact
            icon={FiAlertCircle}
            title="Users couldn’t be loaded"
            description={loadError}
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : users.length === 0 ? (
          <EmptyState
            compact
            icon={FiUsers}
            title="No users yet"
            description="Create the first account with the button above."
          />
        ) : (
          <div className={styles.userList}>
            {users.map((user) => {
              const isOwner = user.roles.includes('owner');
              const isSelf = user.id === currentUserId;
              const locked = isOwner || isSelf;
              const lockedReason = isOwner
                ? 'The owner’s account can’t be deactivated or deleted'
                : 'You can’t deactivate or delete your own account';
              return (
                <div key={user.id} className={styles.userRow}>
                  <div className={styles.userInfo}>
                    <span className={styles.userName}>
                      {user.name}
                      {isSelf && <span className={styles.youTag}> (you)</span>}
                    </span>
                    <span className={styles.userEmail}>{user.email}</span>
                  </div>
                  {/* An owner is also an admin under the hood — one badge says it. */}
                  {(isOwner ? ['owner'] : user.roles).map((r) =>
                    r === 'agent_user' ? (
                      <Badge key={r} variant="accent">
                        {user.assignedAgentId ? agentName(user.assignedAgentId) : 'No AI role'}
                      </Badge>
                    ) : (
                      <Badge key={r} variant={ROLE_BADGE[r] ?? 'neutral'}>
                        {ROLE_LABEL[r] ?? r}
                      </Badge>
                    ),
                  )}
                  {user.storeId && <Badge variant="neutral">{storeName(user.storeId)}</Badge>}
                  {!user.active && <Badge variant="danger">Deactivated</Badge>}
                  {user.aiAccessEnabled === false && <Badge variant="warning">AI off</Badge>}
                  {user.voiceAccessEnabled === false && <Badge variant="warning">Voice off</Badge>}
                  <div className={styles.userActions}>
                    <span
                      title={
                        locked ? lockedReason : user.active ? 'Deactivate — they can no longer sign in' : 'Reactivate'
                      }
                    >
                      <Switch
                        checked={user.active}
                        disabled={locked || busyUserId === user.id}
                        ariaLabel={`${user.name} can sign in`}
                        onChange={(checked) => (checked ? void setActive(user, true) : setDeactivatingUser(user))}
                      />
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isOwner && !isSelf}
                      title={isOwner && !isSelf ? 'Only the owner can edit the owner’s account' : undefined}
                      onClick={() => openEdit(user)}
                    >
                      Edit
                    </Button>
                    <IconButton
                      icon={<FiTrash2 />}
                      label={locked ? lockedReason : `Delete ${user.name}`}
                      title={locked ? lockedReason : `Delete ${user.name}`}
                      size="sm"
                      disabled={locked || busyUserId === user.id}
                      onClick={() => setDeletingUser(user)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Modal open={createOpen} onClose={closeCreateModal} title="Create User" maxWidth={520}>
        {createdResult ? (
          <>
            <div className={styles.modalBody}>
              <p>
                <strong>{createdResult.user.name}</strong> was created
                {createdResult.user.roles[0] === 'agent_user' ? (
                  <>
                    {' '}
                    with the AI role <strong>{agentName(createdResult.user.assignedAgentId)}</strong>
                  </>
                ) : (
                  <>
                    {' '}
                    as <strong>{ROLE_LABEL[createdResult.user.roles[0]] ?? createdResult.user.roles[0]}</strong>
                  </>
                )}
                . They sign in at <strong>{window.location.origin}</strong> with:
              </p>
              <SettingsField label="Email">
                <CopyableText value={createdResult.user.email} />
              </SettingsField>
              <SettingsField label="Temporary password">
                <CopyableText value={createdResult.tempPassword} />
              </SettingsField>
              <p className={styles.warning}>This password will not be shown again after you close this dialog.</p>
            </div>
            <div className={styles.modalFooter}>
              <Button type="button" onClick={closeCreateModal}>
                Done, I’ve copied it
              </Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!createProblem && !creating) void handleCreate();
            }}
          >
            <div className={styles.modalBody}>
              <Input
                label="Name"
                placeholder="e.g. Priya Raman"
                autoFocus
                maxLength={100}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Input
                label="Email"
                type="email"
                placeholder="name@company.com"
                hint="They sign in with this address."
                error={
                  form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())
                    ? 'That email address doesn’t look right.'
                    : undefined
                }
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              {roleFields(form, setForm)}
              <details className={styles.moreOptions}>
                <summary>More options</summary>
                <Input
                  label="Department (optional)"
                  placeholder="e.g. Sales"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                />
                {accessFields(form, setForm)}
              </details>
              {createProblem && (form.name || form.email) && <p className={styles.formProblem}>{createProblem}</p>}
            </div>
            <div className={styles.modalFooter}>
              <Button type="button" variant="ghost" onClick={closeCreateModal} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" loading={creating} disabled={!!createProblem}>
                Create User
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={!!editingUser}
        onClose={() => (saving ? undefined : setEditingUser(null))}
        title="Edit User"
        description={editingUser?.email}
        maxWidth={520}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!editProblem && !saving) void handleEditSave();
          }}
        >
          <div className={styles.modalBody}>
            <Input
              label="Name"
              maxLength={100}
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            />
            {editingOwner ? (
              <SettingsField label="Role" hint="The owner’s role can’t be changed.">
                <Badge variant="warning">Owner</Badge>
              </SettingsField>
            ) : editingUser?.id === currentUserId ? (
              <SettingsField label="Role" hint="You can’t change your own role — ask another admin.">
                <Badge variant={ROLE_BADGE[editForm.role] ?? 'neutral'}>{ROLE_LABEL[editForm.role]}</Badge>
              </SettingsField>
            ) : (
              roleFields(editForm, setEditForm)
            )}
            <details className={styles.moreOptions}>
              <summary>More options</summary>
              <Input
                label="Department (optional)"
                placeholder="e.g. Sales"
                value={editForm.department}
                onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
              />
              {accessFields(editForm, setEditForm)}
            </details>
            {editProblem && <p className={styles.formProblem}>{editProblem}</p>}
          </div>
          <div className={styles.modalFooter}>
            <Button type="button" variant="ghost" onClick={() => setEditingUser(null)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!!editProblem}>
              Save Changes
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!deactivatingUser} onClose={() => setDeactivatingUser(null)} title="Deactivate User" maxWidth={440}>
        <div className={styles.modalBody}>
          <p>
            Deactivate <strong>{deactivatingUser?.name}</strong>? They are signed out everywhere and can’t sign in until
            you reactivate them. Their data is kept.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setDeactivatingUser(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={!!deactivatingUser && busyUserId === deactivatingUser.id}
            onClick={() => deactivatingUser && void setActive(deactivatingUser, false)}
          >
            Deactivate
          </Button>
        </div>
      </Modal>

      <Modal open={!!deletingUser} onClose={() => setDeletingUser(null)} title="Delete User" maxWidth={440}>
        <div className={styles.modalBody}>
          <p>
            Delete <strong>{deletingUser?.name}</strong> ({deletingUser?.email})? Their account is removed for good. To
            only stop them signing in, deactivate them instead.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setDeletingUser(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={!!deletingUser && busyUserId === deletingUser.id}
            onClick={() => void confirmDelete()}
          >
            Delete User
          </Button>
        </div>
      </Modal>

      <Modal
        open={rolesOpen}
        onClose={() => setRolesOpen(false)}
        title="Account types"
        description="What each kind of account can see and do. These are checked by the server on every request."
        maxWidth={640}
      >
        <div className={styles.modalBody}>
          {ROLES.map((role) => (
            <div key={role.id} className={styles.roleCard}>
              <div className={styles.roleCardHead}>
                <Badge variant={ROLE_BADGE[role.id] ?? 'neutral'}>{role.label}</Badge>
                <span>{role.summary}</span>
              </div>
              <ul className={styles.permissionList}>
                {role.can.map((line) => (
                  <li key={line} className={styles.permissionCan}>
                    {line}
                  </li>
                ))}
                {role.cannot.map((line) => (
                  <li key={line} className={styles.permissionCannot}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className={styles.hint}>
            A team member’s access comes from their AI role: its tools, data and app features are set under Settings →
            AI Roles.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" onClick={() => setRolesOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </>
  );
}
