import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import type { IconType } from 'react-icons';
import {
  FiActivity,
  FiBarChart2,
  FiBookOpen,
  FiBriefcase,
  FiCheck,
  FiChevronDown,
  FiCpu,
  FiDatabase,
  FiDollarSign,
  FiFolder,
  FiInbox,
  FiLink2,
  FiLock,
  FiMessageSquare,
  FiMic,
  FiPieChart,
  FiSettings,
  FiTruck,
  FiUsers,
} from 'react-icons/fi';
import { Switch, Tooltip } from '@/components/ui';
import type { PermissionAction, PermissionCatalog, PermissionModule } from '@/services/usersService';
import { ACTION_LABEL, allPermissions, key, normalize, setAction, setPage, summaryText } from './permissionModel';
import styles from './PermissionGrid.module.css';

const MODULE_ICON: Record<string, IconType> = {
  dashboard: FiActivity,
  analytics: FiBarChart2,
  ai_agent: FiMessageSquare,
  customers: FiUsers,
  job_board: FiBriefcase,
  email: FiInbox,
  call_copilot: FiMic,
  business_knowledge: FiBookOpen,
  files: FiFolder,
  reports: FiPieChart,
  finance: FiDollarSign,
  vendors: FiTruck,
  ai_roles: FiCpu,
  users: FiUsers,
  settings: FiSettings,
  integrations: FiLink2,
  crm_integrations: FiDatabase,
};

const NOT_YOURS = 'You can only give access you have yourself.';

export interface PermissionGridProps {
  catalog: PermissionCatalog;
  value: string[];
  onChange?: (next: string[]) => void;
  /** Only these may be turned on (someone who isn't an admin); null = everything. */
  grantable?: readonly string[] | null;
  readOnly?: boolean;
  /** "Reset to AI role defaults" puts these back. */
  defaults?: string[];
  defaultsLabel?: string;
}

/**
 * Which pages someone can open and what they can do on each, grouped the way the
 * app is: a switch per page, and the actions that page really has as chips.
 * Turning a page off clears its actions; any action turns its page on. The list
 * of pages and actions is the server's (GET /users/permission-catalog).
 */
export function PermissionGrid({ catalog, value, onChange, grantable = null, readOnly = false, defaults, defaultsLabel }: PermissionGridProps) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const held = useMemo(() => new Set(value), [value]);
  const allowed = useMemo(() => (grantable ? new Set(grantable) : null), [grantable]);
  const may = (k: string) => !readOnly && (!allowed || allowed.has(k));
  const change = (next: string[]) => onChange?.(next);

  const everything = useMemo(() => {
    const all = allPermissions(catalog);
    return allowed ? all.filter((k) => allowed.has(k)) : all;
  }, [catalog, allowed]);

  const toggleGroup = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderModule = (module: PermissionModule) => {
    const Icon = MODULE_ICON[module.id] ?? FiSettings;
    const viewKey = key(module.id, 'view');
    const on = held.has(viewKey);
    // Turning something off never gives anyone more, so only turning on is limited.
    const switchable = !readOnly && (on || may(viewKey));
    return (
      <li key={module.id} className={clsx(styles.module, on && styles.moduleOn)}>
        <div className={styles.moduleHead}>
          <span className={styles.moduleIcon} aria-hidden>
            <Icon />
          </span>
          <span className={styles.moduleText}>
            <span className={styles.moduleLabel}>{module.label}</span>
            <span className={styles.moduleDescription}>{module.description}</span>
          </span>
          {readOnly ? (
            <span className={clsx(styles.state, on && styles.stateOn)}>{on ? 'On' : 'Off'}</span>
          ) : (
            <span title={!switchable ? NOT_YOURS : undefined}>
              <Switch
                checked={on}
                disabled={!switchable}
                ariaLabel={`${module.label} page`}
                onChange={(checked) => change(setPage(value, module.id, checked, catalog))}
              />
            </span>
          )}
        </div>
        <AnimatePresence initial={false}>
          {on && module.actions.length > 1 && (
            <motion.div
              className={styles.actionsWrap}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0.9, 0.3, 1] }}
            >
              <div className={styles.actions} role="group" aria-label={`${module.label} actions`}>
                {module.actions.map((action: PermissionAction) => {
                  const k = key(module.id, action);
                  const active = held.has(k);
                  const enabled = action !== 'view' && !readOnly && (active || may(k));
                  const hint = module.actionHints[action] ?? ACTION_LABEL[action];
                  return (
                    <Tooltip key={action} content={!may(k) && !readOnly && !active ? NOT_YOURS : hint}>
                      <button
                        type="button"
                        className={clsx(styles.chip, active && styles.chipOn, action === 'view' && styles.chipFixed)}
                        aria-pressed={active}
                        disabled={!enabled}
                        onClick={() => change(setAction(value, module.id, action, !active, catalog))}
                      >
                        {active ? <FiCheck aria-hidden /> : !may(k) && !readOnly ? <FiLock aria-hidden /> : null}
                        {ACTION_LABEL[action]}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </li>
    );
  };

  return (
    <div className={styles.grid}>
      <div className={styles.bar}>
        <span className={styles.summary} aria-live="polite">
          <span className={styles.summaryDot} aria-hidden />
          {summaryText(value)}
        </span>
        {!readOnly && (
          <span className={styles.barActions}>
            <button type="button" className={styles.link} onClick={() => change(normalize(everything, catalog))}>
              Select all
            </button>
            <button type="button" className={styles.link} onClick={() => change([])}>
              Clear all
            </button>
            {defaults && (
              <button
                type="button"
                className={styles.link}
                onClick={() => change(normalize(allowed ? defaults.filter((k) => allowed.has(k)) : defaults, catalog))}
              >
                {defaultsLabel ?? 'Reset to defaults'}
              </button>
            )}
          </span>
        )}
      </div>

      {catalog.groups.map((group) => {
        const modules = catalog.modules.filter((m) => m.group === group.id);
        const onCount = modules.filter((m) => held.has(key(m.id, 'view'))).length;
        const open = !closed.has(group.id);
        return (
          <section key={group.id} className={styles.group}>
            <button type="button" className={styles.groupHead} aria-expanded={open} onClick={() => toggleGroup(group.id)}>
              <span className={styles.groupLabel}>{group.label}</span>
              <span className={styles.groupCount}>
                {onCount} of {modules.length} pages
              </span>
              <FiChevronDown className={clsx(styles.chevron, !open && styles.chevronClosed)} aria-hidden />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.ul
                  className={styles.modules}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.2, 0.9, 0.3, 1] }}
                >
                  {modules.map(renderModule)}
                </motion.ul>
              )}
            </AnimatePresence>
          </section>
        );
      })}

      <p className={styles.footnote}>
        <strong>Always included:</strong> {catalog.alwaysIncluded.join(', ')}. <strong>Owners and admins only:</strong>{' '}
        {catalog.notGrantable.join(', ')}.
      </p>
    </div>
  );
}
