import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { useUiStore } from '@/stores/uiStore';
import { useDataSourceStore } from '@/stores/dataSourceStore';
import { CommandPalette } from '@/components/common/CommandPalette';
import { FloatingAssistant } from '@/components/assistant/FloatingAssistant';
import { ROUTES } from '@/constants/routes';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './AppLayout.module.css';

// Every page fades and rises in as it opens. Keyed on the first path segment
// only — moving between tabs *inside* a section (Settings, a drill-down…)
// is that section's own job, so it isn't animated twice. No exit animation:
// the outgoing <Outlet /> already renders the next route, so fading it out
// would only flash the new page twice.
// Longest block delay (240ms) + the fade itself (400ms), with a little room.
const ENTRANCE_MS = 700;

function PageTransition({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const location = useLocation();
  const section = location.pathname.split('/')[1] ?? '';
  // Switching the CRM data source reloads the page from scratch, so nothing
  // from the previous source (fetched into component state) can linger.
  const sourceVersion = useDataSourceStore((state) => state.version);

  // The staggered block entrance (AppLayout.module.css) runs only while the
  // page is opening; blocks that appear later just appear.
  const [entering, setEntering] = useState(true);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), ENTRANCE_MS);
    return () => window.clearTimeout(timer);
  }, [section, scrollRef]);

  return (
    <motion.div
      key={`${section}:${sourceVersion}`}
      className={styles.page}
      data-entering={entering || undefined}
      // Opacity only — the upward movement comes from the per-block stagger
      // in AppLayout.module.css, so the page doesn't travel twice.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <Outlet />
    </motion.div>
  );
}

export function AppLayout() {
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const location = useLocation();
  const contentRef = useRef<HTMLElement>(null);
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
      <MotionConfig reducedMotion="user">
        <div className={styles.shell}>
          <CommandPalette />
          <Sidebar />
          <div className={styles.mainColumn}>
            <TopBar />
            <main className={styles.content} ref={contentRef}>
              <PageTransition scrollRef={contentRef} />
            </main>
          </div>
          {/* Floats over the page in the bottom-right corner — it no longer
              docks beside the page and squeezes it narrower. */}
          <FloatingAssistant />
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
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
                initial={{ x: -290 }}
                animate={{ x: 0 }}
                exit={{ x: -290 }}
                transition={{ type: 'spring', stiffness: 380, damping: 38, mass: 0.8 }}
              >
                <Sidebar onNavigate={() => setMobileSidebarOpen(false)} />
              </motion.div>
            </>
          )}
        </AnimatePresence>
        <div className={styles.mainColumn}>
          <TopBar onMenuClick={() => setMobileSidebarOpen(true)} />
          <main className={styles.content} ref={contentRef}>
            <PageTransition scrollRef={contentRef} />
          </main>
        </div>

        {/* Same floating window as desktop; on phones its CSS turns it into a bottom sheet. */}
        <FloatingAssistant />
      </div>
    </MotionConfig>
  );
}
