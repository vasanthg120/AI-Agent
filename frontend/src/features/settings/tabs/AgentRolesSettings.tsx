import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiCpu, FiPlus, FiTrash2 } from 'react-icons/fi';
import { Avatar, Badge, Button, IconButton, Spinner } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { ROUTES } from '@/constants/routes';
import { agentRolesService, normalizeRoleCategory, ROLE_CATEGORY_LABEL, type AgentRole } from '@/services/agentRolesService';
import { SettingsSection } from '../components/SettingsSection';
import styles from './AgentRolesSettings.module.css';

// Agent Builder redesign — Create/Edit now live on a dedicated full-page
// wizard (features/agent-builder/AgentBuilderPage.tsx), not a modal here.
// This page stays the read-only list + admin-only edit/delete entry point.
export function AgentRolesSettings() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const loadRoles = async () => {
    setLoadingList(true);
    try {
      setRoles(await agentRolesService.list());
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoadingList(false);
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

  return (
    <SettingsSection icon={<FiCpu />}
      title="AI Agents"
      description="Create and configure AI agents for your organization — built-in personas plus any you create from a template, your documents, or a description."
      footer={
        <Button type="button" leftIcon={<FiPlus />} onClick={() => navigate(ROUTES.settingsAgentRolesNew)}>
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
                {role.department && <span className={styles.roleDept}>{ROLE_CATEGORY_LABEL[normalizeRoleCategory(role.department)]}</span>}
              </div>
              {role.builtin ? (
                <Badge variant="info">Built-in</Badge>
              ) : (
                <Badge variant={role.status === 'active' ? 'success' : 'warning'}>
                  {role.status === 'active' ? 'Active' : 'Draft'}
                </Badge>
              )}
              {!role.builtin && role._id && (
                <div className={styles.roleActions}>
                  {role.status === 'active' && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => navigate(`${ROUTES.chat}?testAgentId=${role.slug}`)}>
                      Test
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(ROUTES.settingsAgentRolesEdit.replace(':id', role._id!))}
                  >
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
  );
}
