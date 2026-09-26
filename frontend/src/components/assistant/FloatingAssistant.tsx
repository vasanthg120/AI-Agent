import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { useUiStore } from '@/stores/uiStore';
import { GlobalAssistantPanel } from './GlobalAssistantPanel';
import styles from './GlobalAssistantPanel.module.css';

// The Haive AI assistant as a floating window in the bottom-right corner —
// it sits OVER the page instead of docking beside it, so opening it never
// narrows or reflows the page underneath (the old docked column squeezed
// every page by 380px). On phones the same window becomes a bottom sheet
// (see the media query in GlobalAssistantPanel.module.css).
export function FloatingAssistant() {
  const open = useUiStore((state) => state.assistantPanelOpen);
  const setOpen = useUiStore((state) => state.setAssistantPanelOpen);
  const [expanded, setExpanded] = useState(false);

  // Esc closes it — on every screen size, only while it's open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={clsx(styles.floating, expanded && styles.floatingExpanded)}
          role="dialog"
          aria-label="Haive AI assistant"
          // Grows out of the bottom-right corner, where it lives.
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
        >
          <GlobalAssistantPanel expanded={expanded} onToggleExpand={() => setExpanded((v) => !v)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
