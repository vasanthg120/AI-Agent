import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'framer-motion';
import { FiChevronRight, FiLock, FiSearch, FiX } from 'react-icons/fi';
import clsx from 'clsx';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { SETTINGS_NAV, type SettingsNavItem } from './settingsNav';
import styles from './SettingsLayout.module.css';

const EASE = [0.16, 1, 0.3, 1] as const;
const PILL_SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 0.7 } as const;

function matchesQuery(item: SettingsNavItem, query: string) {
  if (!query) return true;
  const haystack = [item.label, item.hint, item.summary, ...(item.keywords ?? [])].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const visibleGroups = useMemo(
    () =>
      SETTINGS_NAV.map((group) => ({
        ...group,
        items: group.items.filter((t) => !t.requireRoles || t.requireRoles.some((r) => hasRole(user, r))),
      })).filter((group) => group.items.length > 0),
    [user],
  );

  const allItems = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);
  const activeItem = allItems.find((item) => location.pathname.startsWith(item.path)) ?? allItems[0];
  const activeGroup = visibleGroups.find((g) => g.items.includes(activeItem));

  const filteredGroups = useMemo(
    () =>
      visibleGroups
        .map((group) => ({ ...group, items: group.items.filter((item) => matchesQuery(item, query.trim())) }))
        .filter((group) => group.items.length > 0),
    [visibleGroups, query],
  );
  const firstMatch = filteredGroups[0]?.items[0];

  // "/" jumps to the settings search from anywhere on the page (unless the
  // user is already typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Each tab should open at its top, not wherever the previous tab was scrolled to.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    // On narrow screens the nav is a horizontal chip rail — keep the active chip visible.
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeItem?.id]);

  return (
    <MotionConfig reducedMotion="user">
      <div className={styles.page}>
        <nav ref={navRef} className={styles.nav} aria-label="Settings">
          <div className={styles.navHeader}>
            <div className={styles.title}>Settings</div>
            <div className={styles.subtitle}>Manage your account and workspace</div>
          </div>

          <div className={styles.search}>
            <FiSearch className={styles.searchIcon} aria-hidden />
            <input
              ref={searchRef}
              className={styles.searchInput}
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && firstMatch) {
                  navigate(firstMatch.path);
                  setQuery('');
                  searchRef.current?.blur();
                } else if (e.key === 'Escape') {
                  setQuery('');
                  searchRef.current?.blur();
                }
              }}
            />
            {query ? (
              <button type="button" className={styles.searchClear} onClick={() => setQuery('')} aria-label="Clear search">
                <FiX />
              </button>
            ) : (
              <kbd className={styles.kbd}>/</kbd>
            )}
          </div>

          <LayoutGroup id="settings-nav">
            <div className={styles.groups}>
              <AnimatePresence initial={false} mode="popLayout">
                {filteredGroups.map((group) => (
                  <motion.div
                    key={group.id}
                    layout="position"
                    className={styles.group}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: EASE }}
                  >
                    <div className={styles.groupLabel}>{group.label}</div>
                    <ul className={styles.list}>
                      {group.items.map((item) => {
                        const active = item.id === activeItem?.id;
                        return (
                          <li key={item.id}>
                            <Link
                              to={item.path}
                              className={clsx(styles.item, active && styles.itemActive)}
                              aria-current={active ? 'page' : undefined}
                              onClick={() => setQuery('')}
                            >
                              {active && (
                                <motion.span layoutId="settings-nav-pill" className={styles.pill} transition={PILL_SPRING} />
                              )}
                              <span className={styles.itemIcon}>{item.icon}</span>
                              <span className={styles.itemText}>
                                <span className={styles.itemLabel}>
                                  {item.label}
                                  {item.requireRoles && (
                                    <FiLock className={styles.lock} aria-label="Admin only" title="Admin only" />
                                  )}
                                </span>
                                <span className={styles.itemHint}>{item.hint}</span>
                              </span>
                              <FiChevronRight className={styles.chevron} aria-hidden />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </motion.div>
                ))}
              </AnimatePresence>
              {filteredGroups.length === 0 && (
                <motion.div className={styles.empty} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  No settings match “{query.trim()}”
                </motion.div>
              )}
            </div>
          </LayoutGroup>
        </nav>

        <div className={styles.content} ref={contentRef}>
          <div className={styles.contentInner}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.header
                key={activeItem?.id}
                className={styles.pageHeader}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.24, ease: EASE }}
              >
                <div className={styles.breadcrumb}>
                  <span>Settings</span>
                  <FiChevronRight aria-hidden />
                  <span>{activeGroup?.label}</span>
                </div>
                <div className={styles.headerRow}>
                  <span className={styles.headerIcon}>{activeItem?.icon}</span>
                  <div className={styles.headerText}>
                    <h1 className={styles.headerTitle}>
                      {activeItem?.label}
                      {activeItem?.requireRoles && (
                        <span className={styles.adminBadge}>
                          <FiLock aria-hidden /> Admin
                        </span>
                      )}
                    </h1>
                    <p className={styles.headerSummary}>{activeItem?.summary}</p>
                  </div>
                </div>
              </motion.header>
            </AnimatePresence>

            {/* Keyed by pathname (not tab id) so nested routes inside a tab still
                get a fresh entrance. No exit animation: the outgoing <Outlet />
                already renders the next route, so fading it out would just flash
                the new page twice. */}
            <motion.div
              key={location.pathname}
              className={styles.body}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: EASE, delay: 0.04 }}
            >
              <Outlet />
            </motion.div>
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
