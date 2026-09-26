import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useNotificationsStore } from '@/stores/notificationsStore';
import { useUiStore } from '@/stores/uiStore';
import { CommandPalette } from '@/components/common/CommandPalette';
import { GlobalAssistantPanel } from '@/components/assistant/GlobalAssistantPanel';
import { ROUTES } from '@/constants/routes';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './AppLayout.module.css';

// Every page fades and rises in as it opens. Keyed on the first path segment
// only — moving between tabs *inside* a section (Settings, a drill-down…)
// is that section's own job, so it isn't animated twice. No exit animation:
// the outgoing <Outlet /> already renders the next route, so fading it out
// would only flash the new page twice.
function PageTransition({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const location = useLocation();
  const section = location.pathname.split('/')[1] ?? '';

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [section, scrollRef]);

  return (
    <motion.div
      key={section}
      className={styles.page}
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
          {/* A flex sibling of mainColumn (which is itself `flex: 1; min-width: 0`)
              — the main content naturally shrinks to make room, no overlay.
              Animating `width` itself (not just the panel's own x/opacity) is
              what actually matters here: mainColumn is a flex sibling, so its
              reflow happens the instant this element's layout width changes —
              animating only transform/opacity (the previous approach) let the
              panel fade in smoothly while the dashboard beside it still
              snapped to its narrower width in a single frame. Growing this
              wrapper's width from 0 -> the panel's own fixed width, with
              overflow hidden so the panel is revealed rather than reflowed
              internally, makes both sides of the split move together. */}
          <AnimatePresence>
            {assistantPanelOpen && (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: ASSISTANT_PANEL_WIDTH, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                // A gentler ease-in-out (not the sidebar drawers' aggressive
                // ease-out-expo) — that curve resolves ~80% of the motion in
                // the first third of its duration, which reads as an abrupt
                // snap rather than a smooth open when it's the width itself
                // (not just a transform) driving the reflow of everything
                // beside it. This spreads the motion evenly across the whole
                // duration instead.
                transition={{ duration: 0.38, ease: [0.4, 0, 0.2, 1] }}
                style={{ display: 'flex', height: '100%', overflow: 'hidden', flexShrink: 0 }}
              >
                <GlobalAssistantPanel />
              </motion.div>
            )}
          </AnimatePresence>
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
    </MotionConfig>
  );
}
