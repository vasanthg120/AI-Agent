import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiChevronDown } from 'react-icons/fi';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { NAV_GROUPS } from '@/constants/navigation';
import { hasRole } from '@/utils/roles';
import type { NavItem } from '@/types';
import styles from './Sidebar.module.css';

const EASE = [0.16, 1, 0.3, 1] as const;
const PILL_SPRING = { type: 'spring', stiffness: 420, damping: 38, mass: 0.7 } as const;
const COLLAPSED_GROUPS_KEY = 'enterprise-ai:nav-collapsed-groups';

// Per-viewer convenience only — storage can be unavailable (private mode,
// blocked site data), in which case every group simply starts expanded.
function readCollapsedGroups(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeCollapsedGroups(ids: string[]) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(ids));
  } catch {
    // ignore — see readCollapsedGroups
  }
}

interface HoverState {
  item: NavItem;
  top: number;
  left: number;
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverVisible = useRef(false);
  hoverVisible.current = hover !== null;

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.hideForRoles?.some((r) => hasRole(user, r))),
  })).filter((group) => group.items.length > 0);

  // Navigating into a folded group (via a link, the command palette, the
  // browser's back button…) unfolds it, so the active page is never hidden.
  useEffect(() => {
    const owner = groups.find((g) => g.items.some((item) => location.pathname.startsWith(item.path)));
    if (owner && collapsedGroups.includes(owner.id)) {
      const next = collapsedGroups.filter((id) => id !== owner.id);
      setCollapsedGroups(next);
      writeCollapsedGroups(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const toggleGroup = (id: string) => {
    const next = collapsedGroups.includes(id) ? collapsedGroups.filter((g) => g !== id) : [...collapsedGroups, id];
    setCollapsedGroups(next);
    writeCollapsedGroups(next);
  };

  const showHoverCard = (item: NavItem, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    if (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches) return;
    const rect = el.getBoundingClientRect();
    const sidebarRight = el.closest('aside')?.getBoundingClientRect().right ?? rect.right;
    const next = { item, top: rect.top + rect.height / 2, left: sidebarRight + 10 };
    // Collapsed: the card is the only way to read the label, so it appears
    // almost immediately. Expanded: the label is already visible, so the
    // explanation waits for a deliberate hover instead of flickering past.
    // Once a card is showing, moving to the next item re-targets it right away.
    hoverTimer.current = window.setTimeout(() => setHover(next), collapsed || hoverVisible.current ? 40 : 550);
  };

  const hideHoverCard = () => {
    window.clearTimeout(hoverTimer.current);
    setHover(null);
  };

  // A short grace period, so sliding the pointer from one item to the next
  // glides the card over instead of closing and reopening it.
  const scheduleHideHoverCard = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(null), 90);
  };

  return (
    <nav className={styles.nav} aria-label="Primary" onScroll={hideHoverCard}>
      <LayoutGroup id="sidebar-nav">
        {groups.map((group) => {
          const folded = !collapsed && collapsedGroups.includes(group.id);
          return (
            <div key={group.id} className={styles.navGroup}>
              {collapsed ? (
                <div className={styles.navGroupDivider} aria-hidden />
              ) : (
                group.label && (
                  <button
                    type="button"
                    className={styles.navGroupLabel}
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={!folded}
                  >
                    <span>{group.label}</span>
                    {folded && <span className={styles.navGroupCount}>{group.items.length}</span>}
                    <FiChevronDown className={clsx(styles.navGroupChevron, folded && styles.navGroupChevronFolded)} />
                  </button>
                )
              )}
              <AnimatePresence initial={false}>
                {!folded && (
                  <motion.div
                    className={styles.navGroupItems}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.26, ease: EASE }}
                  >
                    {group.items.map((item) => (
                      <NavLink
                        key={item.id}
                        to={item.path}
                        onClick={() => {
                          hideHoverCard();
                          onNavigate?.();
                        }}
                        onMouseEnter={(e) => showHoverCard(item, e.currentTarget)}
                        onMouseLeave={scheduleHideHoverCard}
                        onFocus={(e) => showHoverCard(item, e.currentTarget)}
                        onBlur={hideHoverCard}
                        aria-label={collapsed ? item.label : undefined}
                        className={({ isActive }) => clsx(styles.navItem, isActive && styles.navItemActive)}
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && (
                              <motion.span layoutId="sidebar-nav-pill" className={styles.navPill} transition={PILL_SPRING} />
                            )}
                            <span className={styles.navIconTile}>
                              <item.icon className={styles.navIcon} />
                            </span>
                            {!collapsed && (
                              <motion.span
                                className={styles.navLabel}
                                initial={{ opacity: 0, x: -6 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ duration: 0.22, ease: EASE, delay: 0.06 }}
                              >
                                {item.label}
                              </motion.span>
                            )}
                            {item.badge ? <span className={styles.navBadge}>{item.badge}</span> : null}
                          </>
                        )}
                      </NavLink>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </LayoutGroup>

      {createPortal(
        <AnimatePresence>
          {hover && (
            <motion.div
              key="nav-hover-card"
              role="tooltip"
              className={styles.hoverCard}
              style={{ left: hover.left }}
              initial={{ opacity: 0, x: -6, y: '-50%', scale: 0.97, top: hover.top }}
              animate={{ opacity: 1, x: 0, y: '-50%', scale: 1, top: hover.top }}
              exit={{ opacity: 0, x: -4, y: '-50%', scale: 0.98 }}
              transition={{ duration: 0.16, ease: EASE }}
            >
              <span className={styles.hoverCardIcon}>
                <hover.item.icon />
              </span>
              <span className={styles.hoverCardText}>
                <span className={styles.hoverCardTitle}>{hover.item.label}</span>
                {hover.item.hint && <span className={styles.hoverCardHint}>{hover.item.hint}</span>}
              </span>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </nav>
  );
}
