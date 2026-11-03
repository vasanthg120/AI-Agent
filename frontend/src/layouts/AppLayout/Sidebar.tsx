import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { FiChevronsLeft, FiChevronsRight, FiChevronRight, FiLogOut, FiUser, FiSettings, FiHelpCircle } from 'react-icons/fi';
import { Logo } from '@/components/common/Logo';
import { IconButton, Avatar, Dropdown, Tooltip } from '@/components/ui';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { ROUTES } from '@/constants/routes';
import { SidebarNav } from './SidebarNav';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  // Called after any in-sidebar navigation (a nav link or a conversation
  // click) — only ever passed by AppLayout's mobile drawer, to close it on
  // navigate. The desktop inline sidebar passes nothing, so it's a no-op there.
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  return (
    <aside className={clsx(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={styles.header}>
        {!collapsed && <Logo />}
        <IconButton
          icon={collapsed ? <FiChevronsRight /> : <FiChevronsLeft />}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleSidebar}
        />
      </div>

      <SidebarNav onNavigate={onNavigate} />

      <div className={styles.footer}>
        {/* No usePortal here — confirmed live (screenshot + DOM inspection)
            that Dropdown's portal-position effect never actually opens the
            menu for this trigger; the plain (non-portal) mode, which is what
            this footer used before the redesign and still uses everywhere
            else in this app, works correctly. .footer has no overflow:hidden
            ancestor, so there was never a clipping reason to need portal
            mode here in the first place. */}
        <Dropdown
          align="left"
          placement="top"
          className={styles.userDropdownWrapper}
          trigger={
            collapsed ? (
              <Tooltip content={user ? `${user.firstName} ${user.lastName}` : 'Account'} placement="right">
                <button type="button" className={styles.userRow} aria-label="Account menu">
                  <Avatar name={user ? `${user.firstName} ${user.lastName}` : 'User'} src={user?.avatarUrl} size="sm" />
                </button>
              </Tooltip>
            ) : (
              <button type="button" className={styles.userRow} aria-label="Account menu">
                <Avatar name={user ? `${user.firstName} ${user.lastName}` : 'User'} src={user?.avatarUrl} size="sm" />
                <span className={styles.userText}>
                  <div className={styles.userName}>{user ? `${user.firstName} ${user.lastName}` : 'User'}</div>
                  <div className={styles.userEmail}>{user?.email}</div>
                </span>
                <FiChevronRight className={styles.userChevron} />
              </button>
            )
          }
          items={[
            { id: 'profile', label: 'Profile', icon: <FiUser />, onSelect: () => navigate(ROUTES.profile) },
            { id: 'settings', label: 'Settings', icon: <FiSettings />, onSelect: () => navigate(ROUTES.settings) },
            {
              id: 'logout',
              label: 'Logout',
              icon: <FiLogOut />,
              danger: true,
              separatorBefore: true,
              onSelect: () => {
                void logout();
                navigate(ROUTES.login);
              },
            },
          ]}
        />

        {collapsed ? (
          <Tooltip content="Help & Support" placement="right">
            <button type="button" className={styles.helpRow} onClick={() => navigate(ROUTES.help)} aria-label="Help & Support">
              <FiHelpCircle className={styles.navIcon} />
            </button>
          </Tooltip>
        ) : (
          <button type="button" className={styles.helpRow} onClick={() => navigate(ROUTES.help)}>
            <FiHelpCircle className={styles.navIcon} />
            Help & Support
          </button>
        )}
      </div>
    </aside>
  );
}
