import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiCpu, FiPlus, FiTrash2 } from 'react-icons/fi';
import { Avatar, Badge, Button, IconButton, Modal, Spinner } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { agentRolesService, type AgentRole } from '@/services/agentRolesService';
import { usersService, type AdminUser } from '@/services/usersService';
import { SettingsSection } from '../components/SettingsSection';
import { AgentConfigurationForm } from './agent-roles/AgentConfigurationForm';
import { CreateAgentDialog } from './agent-roles/CreateAgentDialog';
import styles from './AgentRolesSettings.module.css';

// Agent Builder Phase 1 — this page used to be a single "upload a document,
// review the extracted persona" flow. It's now the entry point into four
// creation methods (Template/Documents/Describe/Manual, see
// agent-roles/CreateAgentDialog.tsx) feeding one shared, sectioned
// configuration editor (agent-roles/AgentConfigurationForm.tsx) for both
// reviewing a freshly-generated/manual config and editing an existing role
// later. The roles list and its admin-only edit/delete actions are extended,
// not replaced — every existing role (including ones with no `goals` yet,
// since that field is additive) keeps working unchanged.
export function AgentRolesSettings() {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<AgentRole | null>(null);

  const loadRoles = async () => {
    setLoadingList(true);
    try {
      setRoles(await agentRolesService.list());
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoadingList(false);
    }
    // Separate, non-fatal: GET /users is admin-only, but this page (and its
    // read-only role list) is reachable by every non-agent_user role — a
    // 403 here must not break the page for them, only leave the "Visible To
    // Employees" picker empty (which only admins can act on anyway, since
    // editing/saving a role is already admin-gated server-side).
    try {
      setUsers(await usersService.list());
    } catch {
      setUsers([]);
    }
  };

  useEffect(() => {
    void loadRoles();
  }, []);

  const handleDelete = async (role: AgentRole) => {
    if (!role._id) return;
    if (!window.confirm(`Delete "${role.name}"? This cannot be undone.`)) return;
    try {
      await agentRolesService.remove(role._id);
      toast.success('Role deleted');
      await loadRoles();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const handleCreated = (role: AgentRole) => {
    setRoles((prev) => [role, ...prev]);
  };

  const handleEdited = (role: AgentRole) => {
    setRoles((prev) => prev.map((r) => (r._id === role._id ? role : r)));
    setEditingRole(null);
  };

  return (
    <>
      <SettingsSection icon={<FiCpu />}
        title="AI Agents"
        description="Create and configure AI agents for your organization — built-in personas plus any you create from a template, your documents, or a description."
        footer={
          <Button type="button" leftIcon={<FiPlus />} onClick={() => setCreateOpen(true)}>
            Create AI Agent
          </Button>
        }
      >
        {loadingList ? (
          <div className={styles.loadingRow}>
            <Spinner size={16} />
            Loading agents…
          </div>
        ) : (
          <div className={styles.roleList}>
            {roles.map((role) => (
              <div key={role._id ?? role.slug} className={styles.roleRow}>
                <Avatar name={role.name} color={role.avatarColor} size="sm" />
                <div className={styles.roleInfo}>
                  <span className={styles.roleName}>{role.name}</span>
                  {role.department && <span className={styles.roleDept}>{role.department}</span>}
                </div>
                {role.builtin ? (
                  <Badge variant="info">Built-in</Badge>
                ) : (
                  <Badge variant={role.status === 'active' ? 'success' : 'warning'}>
                    {role.status === 'active' ? 'Active' : 'Draft'}
                  </Badge>
                )}
                {!role.builtin && (
                  <div className={styles.roleActions}>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditingRole(role)}>
                      Edit
                    </Button>
                    <IconButton icon={<FiTrash2 />} label="Delete role" size="sm" onClick={() => void handleDelete(role)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <CreateAgentDialog open={createOpen} users={users} onClose={() => setCreateOpen(false)} onSaved={handleCreated} />

      <Modal open={!!editingRole} onClose={() => setEditingRole(null)} maxWidth={720}>
        {editingRole && (
          <AgentConfigurationForm role={editingRole} users={users} onSaved={handleEdited} onCancel={() => setEditingRole(null)} />
        )}
      </Modal>
    </>
  );
}
