import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiTrash2 } from 'react-icons/fi';
import { Badge, Button, IconButton, Input, Modal, Switch } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { agentRolesService, type AgentRole } from '@/services/agentRolesService';
import { organizationsService, type Store } from '@/services/organizationsService';
import { useAuthStore } from '@/stores/authStore';
import { usersService, type AdminUser, type AssignableRole, type CreateUserResult } from '@/services/usersService';
import { SettingsField, SettingsSection } from '../components/SettingsSection';
import styles from './UsersSettings.module.css';

const ROLE_BADGE: Record<string, 'info' | 'accent' | 'neutral' | 'success'> = {
  admin: 'info',
  agent_user: 'accent',
  user: 'neutral',
  manager: 'success',
  consultant: 'success',
};

// Manager/Consultant dashboards (Phase 3) are store-scoped — a store
// assignment is required for both roles, not just Manager, so rosters never
// have an unassigned consultant (see backend's STORE_SCOPED_ROLES).
const STORE_SCOPED_ROLES = new Set<AssignableRole>(['manager', 'consultant']);

const emptyForm = {
  email: '',
  name: '',
  role: 'agent_user' as AssignableRole,
  assignedAgentId: '',
  storeId: '',
  department: '',
};

export function UsersSettings() {
  const currentUserId = useAuthStore((state) => state.user?.id);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [agentRoles, setAgentRoles] = useState<AgentRole[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreateUserResult | null>(null);

  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<{
    role: AssignableRole;
    assignedAgentId: string;
    storeId: string;
    department: string;
  }>({
    role: 'agent_user',
    assignedAgentId: '',
    storeId: '',
    department: '',
  });
  const [saving, setSaving] = useState(false);

  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [userList, roleList, storeList] = await Promise.all([
        usersService.list(),
        agentRolesService.list(),
        organizationsService.listStores(),
      ]);
      setUsers(userList);
      setAgentRoles(roleList);
      setStores(storeList);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Agent User accounts lock to one org-created agent (see backend's
  // resolveValidAgentIds) — built-in personas and drafts aren't assignable,
  // so this dropdown only ever offers the agents someone actually created
  // and activated.
  const createdAgents = agentRoles.filter((role) => !role.builtin && role.status === 'active');

  useEffect(() => {
    void load();
  }, []);

  const closeCreateModal = () => {
    setCreateOpen(false);
    setForm(emptyForm);
    setCreatedResult(null);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await usersService.create({
        email: form.email,
        name: form.name,
        role: form.role,
        assignedAgentId: form.role === 'agent_user' ? form.assignedAgentId : undefined,
        storeId: STORE_SCOPED_ROLES.has(form.role) ? form.storeId : undefined,
        department: form.department || undefined,
      });
      setCreatedResult(result);
      await load();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (user: AdminUser) => {
    try {
      const updated = await usersService.update(user.id, { active: !user.active });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const openEdit = (user: AdminUser) => {
    setEditingUser(user);
    setEditForm({
      role: (user.roles[0] as AssignableRole) ?? 'user',
      assignedAgentId: user.assignedAgentId ?? '',
      storeId: user.storeId ?? '',
      department: user.department ?? '',
    });
  };

  const handleEditSave = async () => {
    if (!editingUser) return;
    setSaving(true);
    try {
      const updated = await usersService.update(editingUser.id, {
        role: editForm.role,
        assignedAgentId: editForm.role === 'agent_user' ? editForm.assignedAgentId : undefined,
        storeId: STORE_SCOPED_ROLES.has(editForm.role) ? editForm.storeId : undefined,
        department: editForm.department || undefined,
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success('User updated');
      setEditingUser(null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingUser) return;
    setDeleting(true);
    try {
      await usersService.remove(deletingUser.id);
      setUsers((prev) => prev.filter((u) => u.id !== deletingUser.id));
      toast.success('User deleted');
      setDeletingUser(null);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  // Falls back to a readable placeholder, never the raw id — an
  // agent/store that's since been deleted shouldn't surface its Mongo id.
  const agentName = (agentId?: string) => agentRoles.find((a) => a.slug === agentId)?.name ?? 'Unknown agent';
  const storeName = (storeId?: string) => stores.find((s) => s._id === storeId)?.name ?? 'Unknown store';

  return (
    <>
      <SettingsSection
        title="Create a New User"
        description="Create an account directly and assign it a role. Agent User accounts are locked to a single AI agent."
        footer={
          <Button type="button" onClick={() => setCreateOpen(true)}>
            + Create User
          </Button>
        }
      >
        <p>Users you create here get a temporary password shown once — share it with them directly.</p>
      </SettingsSection>

      <SettingsSection title="Existing Users" description="All accounts in this workspace.">
        {loading ? (
          <p>Loading users…</p>
        ) : (
          <div className={styles.userList}>
            {users.map((user) => (
              <div key={user.id} className={styles.userRow}>
                <div className={styles.userInfo}>
                  <span className={styles.userName}>{user.name}</span>
                  <span className={styles.userEmail}>{user.email}</span>
                </div>
                {user.roles.map((r) => (
                  <Badge key={r} variant={ROLE_BADGE[r] ?? 'neutral'}>
                    {r}
                  </Badge>
                ))}
                {user.assignedAgentId && <Badge variant="neutral">{agentName(user.assignedAgentId)}</Badge>}
                {user.storeId && <Badge variant="neutral">{storeName(user.storeId)}</Badge>}
                <div className={styles.userActions}>
                  <Switch checked={user.active} onChange={() => void handleToggleActive(user)} />
                  <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(user)}>
                    Edit
                  </Button>
                  <IconButton
                    icon={<FiTrash2 />}
                    label="Delete user"
                    size="sm"
                    disabled={user.id === currentUserId}
                    onClick={() => setDeletingUser(user)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <Modal open={createOpen} onClose={closeCreateModal} title="Create User" maxWidth={480}>
        {createdResult ? (
          <>
            <div className={styles.modalBody}>
              <p>
                <strong>{createdResult.user.name}</strong> was created. Share this temporary password with them —
                it will not be shown again.
              </p>
              <div className={styles.passwordBox}>{createdResult.tempPassword}</div>
              <p className={styles.warning}>This password will not be shown again after you close this dialog.</p>
            </div>
            <div className={styles.modalFooter}>
              <Button type="button" onClick={closeCreateModal}>
                Done, I've copied it
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.modalBody}>
              <Input
                label="Email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <SettingsField label="Role">
                <select
                  className={styles.select}
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as AssignableRole })}
                >
                  <option value="manager">Manager (store dashboard)</option>
                  <option value="consultant">Consultant (personal dashboard)</option>
                  <option value="agent_user">Agent User (locked to one AI agent)</option>
                  <option value="admin">Admin (full access)</option>
                  <option value="user">User (full access, legacy)</option>
                </select>
              </SettingsField>
              {form.role === 'agent_user' && (
                <SettingsField label="Assigned Agent">
                  <select
                    className={styles.select}
                    value={form.assignedAgentId}
                    onChange={(e) => setForm({ ...form, assignedAgentId: e.target.value })}
                  >
                    <option value="" disabled>
                      Select an agent…
                    </option>
                    {createdAgents.map((a) => (
                      <option key={a.slug} value={a.slug}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {createdAgents.length === 0 && (
                    <p className={styles.hint}>No custom agents yet — create one under Settings → AI Agents first.</p>
                  )}
                </SettingsField>
              )}
              {STORE_SCOPED_ROLES.has(form.role) && (
                <SettingsField label="Store">
                  <select
                    className={styles.select}
                    value={form.storeId}
                    onChange={(e) => setForm({ ...form, storeId: e.target.value })}
                  >
                    <option value="" disabled>
                      Select a store…
                    </option>
                    {stores.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </SettingsField>
              )}
              <Input
                label="Department (optional)"
                placeholder="e.g. Sales"
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
              />
            </div>
            <div className={styles.modalFooter}>
              <Button type="button" variant="ghost" onClick={closeCreateModal}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={
                  creating ||
                  !form.email ||
                  !form.name ||
                  (form.role === 'agent_user' && !form.assignedAgentId) ||
                  (STORE_SCOPED_ROLES.has(form.role) && !form.storeId)
                }
                onClick={() => void handleCreate()}
              >
                {creating ? 'Creating…' : 'Create User'}
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!editingUser} onClose={() => setEditingUser(null)} title="Edit User" maxWidth={480}>
        <div className={styles.modalBody}>
          <SettingsField label="Role">
            <select
              className={styles.select}
              value={editForm.role}
              onChange={(e) => setEditForm({ ...editForm, role: e.target.value as AssignableRole })}
            >
              <option value="manager">Manager (store dashboard)</option>
              <option value="consultant">Consultant (personal dashboard)</option>
              <option value="agent_user">Agent User (locked to one AI agent)</option>
              <option value="admin">Admin (full access)</option>
              <option value="user">User (full access, legacy)</option>
            </select>
          </SettingsField>
          {editForm.role === 'agent_user' && (
            <SettingsField label="Assigned Agent">
              <select
                className={styles.select}
                value={editForm.assignedAgentId}
                onChange={(e) => setEditForm({ ...editForm, assignedAgentId: e.target.value })}
              >
                <option value="" disabled>
                  Select an agent…
                </option>
                {createdAgents.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
            </SettingsField>
          )}
          {STORE_SCOPED_ROLES.has(editForm.role) && (
            <SettingsField label="Store">
              <select
                className={styles.select}
                value={editForm.storeId}
                onChange={(e) => setEditForm({ ...editForm, storeId: e.target.value })}
              >
                <option value="" disabled>
                  Select a store…
                </option>
                {stores.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </SettingsField>
          )}
          <Input
            label="Department (optional)"
            placeholder="e.g. Sales"
            value={editForm.department}
            onChange={(e) => setEditForm({ ...editForm, department: e.target.value })}
          />
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setEditingUser(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              saving ||
              (editForm.role === 'agent_user' && !editForm.assignedAgentId) ||
              (STORE_SCOPED_ROLES.has(editForm.role) && !editForm.storeId)
            }
            onClick={() => void handleEditSave()}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </Modal>

      <Modal open={!!deletingUser} onClose={() => setDeletingUser(null)} title="Delete User" maxWidth={420}>
        <div className={styles.modalBody}>
          <p>
            Delete <strong>{deletingUser?.name}</strong>? This cannot be undone.
          </p>
        </div>
        <div className={styles.modalFooter}>
          <Button type="button" variant="ghost" onClick={() => setDeletingUser(null)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" disabled={deleting} onClick={() => void confirmDelete()}>
            {deleting ? 'Deleting…' : 'Delete User'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
