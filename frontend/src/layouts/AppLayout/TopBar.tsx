import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { FiBell, FiSidebar, FiMenu, FiCommand, FiChevronRight } from 'react-icons/fi';
import { IconButton, Avatar } from '@/components/ui';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { NAV_GROUPS } from '@/constants/navigation';
import { ROUTES } from '@/constants/routes';
import styles from './TopBar.module.css';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const QUICK_ACTIONS_SHORTCUT = IS_MAC ? '⌘ /' : 'Ctrl /';

export interface TopBarProps {
  onMenuClick?: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const assistantPanelOpen = useUiStore((state) => state.assistantPanelOpen);
  const toggleAssistantPanel = useUiStore((state) => state.toggleAssistantPanel);
  const unreadCount = useNotificationsStore((state) => state.unreadCount());
  const user = useAuthStore((state) => state.user);

  // Two-level breadcrumb: the owning nav group's label (Workspace/
  // Operations), then the page title — falls back to a bare title for
  // routes that aren't in NAV_GROUPS (Chat, Profile, Settings, Help).
  const breadcrumb = useMemo(() => {
    if (location.pathname.startsWith(ROUTES.chat)) return { group: null, title: 'Chat' };
    if (location.pathname.startsWith(ROUTES.profile)) return { group: null, title: 'Profile' };
    if (location.pathname.startsWith(ROUTES.settings)) return { group: null, title: 'Settings' };
    if (location.pathname.startsWith(ROUTES.help)) return { group: null, title: 'Help & Support' };
    for (const group of NAV_GROUPS) {
      const match = group.items.find((item) => location.pathname.startsWith(item.path));
      if (match) return { group: group.label ?? null, title: match.label };
    }
    return { group: null, title: 'HaiVE AI' };
  }, [location.pathname]);

  const isChatRoute = location.pathname.startsWith(ROUTES.chat);

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {onMenuClick && <IconButton icon={<FiMenu />} label="Open menu" onClick={onMenuClick} />}
        <span className={styles.breadcrumb}>
          {breadcrumb.group && (
            <>
              <span className={styles.breadcrumbGroup}>{breadcrumb.group}</span>
              <FiChevronRight className={styles.breadcrumbSeparator} />
            </>
          )}
          <span className={styles.breadcrumbTitle}>{breadcrumb.title}</span>
        </span>
      </div>
      <div className={styles.right}>
        <button type="button" className={styles.quickActions} onClick={() => setCommandPaletteOpen(true)}>
          <FiCommand />
          <span className={styles.quickActionsLabel}>Quick actions</span>
          <span className={styles.quickActionsShortcut}>{QUICK_ACTIONS_SHORTCUT}</span>
        </button>

        <span className={styles.notificationWrapper}>
          <IconButton icon={<FiBell />} label="Notifications" onClick={() => navigate(ROUTES.notifications)} />
          {unreadCount > 0 && <span className={styles.notificationDot} />}
        </span>
        {isChatRoute && (
          <IconButton
            icon={<FiSidebar />}
            label={rightPanelOpen ? 'Hide details panel' : 'Show details panel'}
            active={rightPanelOpen}
            onClick={toggleRightPanel}
          />
        )}

        {/* Hidden on the full Chat page itself — that page already IS the
            complete Agentic Chat experience this panel is a compact,
            workspace-wide shortcut to (see AppLayout.tsx's matching
            auto-close effect). */}
        {!isChatRoute && (
          <button
            type="button"
            className={clsx(styles.assistantTrigger, assistantPanelOpen && styles.assistantTriggerActive)}
            aria-label={assistantPanelOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
            title={assistantPanelOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
            onClick={toggleAssistantPanel}
          >
            <img src="/haive-logo.png" alt="" className={styles.assistantTriggerIcon} />
            <span className={styles.assistantTriggerLabel}>Haive AI</span>
          </button>
        )}

        <button type="button" className={styles.avatarButton} onClick={() => navigate(ROUTES.profile)} aria-label="Profile">
          <Avatar name={user ? `${user.firstName} ${user.lastName}` : 'User'} size="sm" />
        </button>
      </div>
    </header>
  );
}
