import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { FiSettings, FiBell, FiShield, FiUsers, FiUserPlus, FiTarget, FiUserCheck, FiPercent, FiLink2, FiClock } from 'react-icons/fi';
import { Tabs } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import styles from './SettingsLayout.module.css';

const TAB_ITEMS = [
  { id: 'general', label: 'General', icon: <FiSettings />, path: ROUTES.settingsGeneral },
  { id: 'notifications', label: 'Notifications', icon: <FiBell />, path: ROUTES.settingsNotifications },
  { id: 'security', label: 'Security', icon: <FiShield />, path: ROUTES.settingsSecurity },
  { id: 'agent-roles', label: 'AI Roles', icon: <FiUsers />, path: ROUTES.settingsAgentRoles },
  // Moved out of the main sidebar nav (was its own top-level page) — same
  // visibility as the tabs above (open to everyone except agent_user, via
  // the shared BlockRole wrapping the whole /settings subtree in
  // routes/index.tsx), no additional requireRoles needed.
  { id: 'integrations', label: 'Integrations', icon: <FiLink2 />, path: ROUTES.settingsIntegrations },
  { id: 'users', label: 'Users', icon: <FiUserPlus />, path: ROUTES.settingsUsers, requireRoles: ['admin'] },
  {
    id: 'sales-targets',
    label: 'Sales Targets',
    icon: <FiTarget />,
    path: ROUTES.settingsSalesTargets,
    requireRoles: ['admin'],
  },
  {
    id: 'deal-assignment',
    label: 'Deal Assignment',
    icon: <FiUserCheck />,
    path: ROUTES.settingsDealAssignment,
    requireRoles: ['admin'],
  },
  {
    id: 'royalty-rules',
    label: 'Royalty Rules',
    icon: <FiPercent />,
    path: ROUTES.settingsRoyaltyRules,
    // Widened to ['owner','admin'] — matches RoyaltyRulesController's actual
    // backend gate, unlike every other tab above (['admin']-only), since
    // this is sensitive org-wide financial configuration.
    requireRoles: ['owner', 'admin'],
  },
  {
    id: 'email-sla',
    label: 'Email SLA',
    icon: <FiClock />,
    path: ROUTES.settingsEmailSla,
    // Matches EmailSlaController's mutation gate (owner/admin) — the
    // read-only policy list route allows manager too, but this tab is
    // primarily for configuring policy, so it stays owner/admin only.
    requireRoles: ['owner', 'admin'],
  },
];

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const visibleTabs = TAB_ITEMS.filter((t) => !t.requireRoles || t.requireRoles.some((r) => hasRole(user, r)));
  const activeId = visibleTabs.find((item) => location.pathname.startsWith(item.path))?.id ?? 'general';

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <div className={styles.title}>Settings</div>
        <Tabs
          orientation="vertical"
          items={visibleTabs}
          activeId={activeId}
          onChange={(id) => {
            const target = visibleTabs.find((item) => item.id === id);
            if (target) navigate(target.path);
          }}
        />
      </nav>
      <div className={styles.content}>
        <div className={styles.contentInner}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
