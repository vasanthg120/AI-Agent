import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiSearch, FiPlus, FiUser, FiHelpCircle, FiMessageCircle } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { Input } from '@/components/ui';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { NAV_GROUPS } from '@/constants/navigation';
import { ROUTES } from '@/constants/routes';
import { hasRole } from '@/utils/roles';
import styles from './CommandPalette.module.css';

interface Action {
  id: string;
  label: string;
  section: string;
  icon: IconType;
  onSelect: () => void;
}

// Global Cmd/Ctrl+/ toggle — this component is mounted once (AppLayout.tsx)
// regardless of commandPaletteOpen, exactly like SidebarChatSection used to
// listen for Cmd+K app-wide before it was removed.
export function CommandPalette() {
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const user = useAuthStore((state) => state.user);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
  };

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      { id: 'new-chat', label: 'New conversation', section: 'Quick Actions', icon: FiPlus, onSelect: () => { startNewConversation(); go(ROUTES.chat); } },
      { id: 'chat', label: 'Go to Chat', section: 'Quick Actions', icon: FiMessageCircle, onSelect: () => go(ROUTES.chat) },
      { id: 'profile', label: 'Profile', section: 'Quick Actions', icon: FiUser, onSelect: () => go(ROUTES.profile) },
      { id: 'help', label: 'Help & Support', section: 'Quick Actions', icon: FiHelpCircle, onSelect: () => go(ROUTES.help) },
    ];
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.hideForRoles?.some((r) => hasRole(user, r))) continue;
        list.push({ id: item.id, label: item.label, section: group.label ?? 'More', icon: item.icon, onSelect: () => go(item.path) });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        filtered[activeIndex]?.onSelect();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, activeIndex]);

  let runningIndex = -1;
  const sections = useMemo(() => {
    const bySection = new Map<string, Action[]>();
    for (const action of filtered) {
      if (!bySection.has(action.section)) bySection.set(action.section, []);
      bySection.get(action.section)!.push(action);
    }
    return [...bySection.entries()];
  }, [filtered]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Quick actions"
            className={styles.palette}
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.searchRow}>
              <Input
                ref={inputRef}
                placeholder="Search actions and pages..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leftIcon={<FiSearch />}
                aria-label="Search quick actions"
              />
            </div>
            <div className={styles.results}>
              {filtered.length === 0 && <div className={styles.empty}>No matching actions.</div>}
              {sections.map(([section, items]) => (
                <div key={section}>
                  <div className={styles.sectionLabel}>{section}</div>
                  {items.map((action) => {
                    runningIndex += 1;
                    const index = runningIndex;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        className={clsx(styles.result, index === activeIndex && styles.resultActive)}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => action.onSelect()}
                      >
                        <action.icon className={styles.resultIcon} />
                        {action.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
