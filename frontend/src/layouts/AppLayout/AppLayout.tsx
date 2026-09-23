import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { useUiStore } from '@/stores/uiStore';
import { CommandPalette } from '@/components/common/CommandPalette';
import { GlobalAssistantPanel } from '@/components/assistant/GlobalAssistantPanel';
import { ROUTES } from '@/constants/routes';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './AppLayout.module.css';

export function AppLayout() {
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const location = useLocation();
  const assistantPanelOpen = useUiStore((state) => state.assistantPanelOpen);
  const setAssistantPanelOpen = useUiStore((state) => state.setAssistantPanelOpen);

  // The full Chat page already IS the complete Agentic Chat experience —
  // showing the compact global panel on top of it would be a redundant
  // second chat UI on screen at once. Auto-closes rather than just hiding,
  // so returning to any other page starts from a clean closed state instead
  // of a panel that silently reopens the moment you navigate away.
  useEffect(() => {
    if (location.pathname.startsWith(ROUTES.chat) && assistantPanelOpen) {
      setAssistantPanelOpen(false);
    }
  }, [location.pathname, assistantPanelOpen, setAssistantPanelOpen]);

  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  // Escape closes the mobile drawer — same convention Modal.tsx already
  // uses for its own backdrop dialogs. Only listens while the drawer is
  // actually open, so it never intercepts Escape elsewhere in the app.
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileSidebarOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mobileSidebarOpen]);

  // Same Escape convention as the mobile sidebar drawer above, scoped to
  // the mobile assistant overlay only (desktop's docked panel has its own
  // visible close button and doesn't need a global key listener).
  useEffect(() => {
    if (!isMobile || !assistantPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAssistantPanelOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isMobile, assistantPanelOpen, setAssistantPanelOpen]);

  // Fetches existing notifications and subscribes to live push as soon as
  // any authenticated page mounts — not just when the user opens the
  // Notifications page — so the TopBar's unread dot (see TopBar.tsx) is
  // accurate app-wide, and proactive AI notifications (app.workflows in
  // python-agent) arrive live without a manual refresh.
  useEffect(() => {
    useNotificationsStore.getState().init();
  }, []);

  if (!isMobile) {
    return (
      <div className={styles.shell}>
        <CommandPalette />
        <Sidebar />
        <div className={styles.mainColumn}>
          <TopBar />
          <main className={styles.content}>
            <Outlet />
          </main>
        </div>
        {/* A flex sibling of mainColumn (which is itself `flex: 1; min-width: 0`)
            — the main content naturally shrinks to make room, no overlay. Same
            slide+fade motion language as the mobile drawers below (identical
            easing curve) rather than an abrupt mount/unmount. */}
        <AnimatePresence>
          {assistantPanelOpen && (
            <motion.div
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              style={{ display: 'flex', height: '100%' }}
            >
              <GlobalAssistantPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <CommandPalette />
      <AnimatePresence>
        {mobileSidebarOpen && (
          <>
            <motion.div
              className={styles.mobileSidebarBackdrop}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileSidebarOpen(false)}
            />
            <motion.div
              className={styles.sidebarMobile}
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            >
              <Sidebar onNavigate={() => setMobileSidebarOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <div className={styles.mainColumn}>
        <TopBar onMenuClick={() => setMobileSidebarOpen(true)} />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {/* Same backdrop+slide-in idiom as the mobile sidebar above — docking a
          fixed-width panel next to the page on a narrow viewport would leave
          almost no room for either, so it becomes an overlay drawer instead. */}
      <AnimatePresence>
        {assistantPanelOpen && (
          <>
            <motion.div
              className={styles.mobileSidebarBackdrop}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setAssistantPanelOpen(false)}
            />
            <motion.div
              className={styles.assistantPanelMobile}
              initial={{ x: 380 }}
              animate={{ x: 0 }}
              exit={{ x: 380 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            >
              <GlobalAssistantPanel />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
