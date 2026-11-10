import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiCheck, FiSearch, FiShield } from 'react-icons/fi';
import { Badge, Input } from '@/components/ui';
import { toolLabel } from '@/features/agent-builder/toolCatalog';
import type { AssignableAiRole, PermissionCatalog } from '@/services/usersService';
import { pageLabels } from './permissionModel';
import styles from './UserDrawer.module.css';

export const ADMINISTRATOR = '__administrator__';

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  );
}

/**
 * The AI roles a person can be given, as cards to choose from, plus
 * "Administrator" for those allowed to make one. The chosen role's agent is
 * described underneath: what it does, its tools, and where access starts.
 */
export function AiRolePicker({
  roles,
  value,
  onChange,
  allowAdministrator,
  catalog,
}: {
  roles: AssignableAiRole[];
  value: string;
  onChange: (slug: string) => void;
  allowAdministrator: boolean;
  catalog: PermissionCatalog;
}) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => [r.name, r.description, r.accountType].some((text) => text.toLowerCase().includes(q)));
  }, [roles, search]);
  const chosen = roles.find((r) => r.slug === value);

  return (
    <div className={styles.picker}>
      {roles.length > 4 && (
        <Input
          aria-label="Search AI roles"
          placeholder="Search AI roles"
          leftIcon={<FiSearch />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className={styles.roleList} role="radiogroup" aria-label="AI role">
        {shown.map((role) => {
          const selected = role.slug === value;
          return (
            <button
              key={role.slug}
              type="button"
              role="radio"
              aria-checked={selected}
              className={clsx(styles.roleCard, selected && styles.roleCardOn)}
              onClick={() => onChange(role.slug)}
            >
              <span className={styles.roleAvatar} style={{ background: role.avatarColor ?? 'var(--color-accent)' }} aria-hidden>
                {initials(role.name)}
              </span>
              <span className={styles.roleText}>
                <span className={styles.roleName}>{role.name}</span>
                <span className={styles.roleMeta}>
                  {role.accountType}
                  {role.people > 0 ? ` · ${role.people} ${role.people === 1 ? 'person' : 'people'}` : ''}
                </span>
                {role.description && <span className={styles.roleDescription}>{role.description}</span>}
              </span>
              {selected && <FiCheck className={styles.roleCheck} aria-hidden />}
            </button>
          );
        })}
        {allowAdministrator && (
          <button
            type="button"
            role="radio"
            aria-checked={value === ADMINISTRATOR}
            className={clsx(styles.roleCard, value === ADMINISTRATOR && styles.roleCardOn)}
            onClick={() => onChange(ADMINISTRATOR)}
          >
            <span className={clsx(styles.roleAvatar, styles.adminAvatar)} aria-hidden>
              <FiShield />
            </span>
            <span className={styles.roleText}>
              <span className={styles.roleName}>Administrator</span>
              <span className={styles.roleMeta}>Full access · every agent</span>
              <span className={styles.roleDescription}>Runs the workspace: every page, every agent, users and settings.</span>
            </span>
            {value === ADMINISTRATOR && <FiCheck className={styles.roleCheck} aria-hidden />}
          </button>
        )}
        {shown.length === 0 && search && <p className={styles.muted}>No AI role matches “{search}”.</p>}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {chosen && (
          <motion.div
            key={chosen.slug}
            className={styles.agentPanel}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
          >
            <div className={styles.agentHead}>
              <span className={styles.agentLabel}>Their AI agent</span>
              <Badge variant="accent">{chosen.accountType}</Badge>
            </div>
            <p className={styles.agentText}>
              <strong>{chosen.name}</strong>
              {chosen.description ? ` — ${chosen.description}` : ''}
            </p>
            <dl className={styles.agentFacts}>
              <div>
                <dt>In chat</dt>
                <dd>They work with this agent only; it acts with its own instructions and tools.</dd>
              </div>
              <div>
                <dt>Its tools</dt>
                <dd>{chosen.allowedTools.length ? chosen.allowedTools.map(toolLabel).join(', ') : 'Every tool HaiVE has'}</dd>
              </div>
              <div>
                <dt>Starts with</dt>
                <dd>{pageLabels(chosen.defaultPermissions, catalog).join(', ') || 'Only the basics'}</dd>
              </div>
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
