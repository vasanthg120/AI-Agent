import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { FiChevronDown, FiChevronUp, FiLogOut, FiMenu, FiUser, FiX } from 'react-icons/fi';
import { Dropdown } from '@/components/ui';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ADMIN_ROUTES } from '@/constants/routes';
import { ADMIN_NAV_ITEMS, ADMIN_NAV_MORE_SECTION, ADMIN_NAV_SECTIONS } from '../adminNav';
import styles from './AdminLayout.module.css';

// Deliberately its own shell — not AppLayout — so this area is visually and
// structurally separate from the customer app, per the request. Reads
// useAdminAuthStore — a fully separate credential from the customer app's
// session, not just a separate UI area over the same login.
export function AdminLayout() {
  const isMobile = useMediaQuery('(max-width: 960px)');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const admin = useAdminAuthStore((state) => state.admin);
  const logout = useAdminAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    toast.success('Signed out');
    navigate(ADMIN_ROUTES.signin, { replace: true });
  };

  const moreItems = ADMIN_NAV_ITEMS.filter((item) => item.section === ADMIN_NAV_MORE_SECTION);

  const nav = (
    <nav className={styles.nav} aria-label="Admin navigation">
      {ADMIN_NAV_SECTIONS.map((section) => (
        <div key={section} className={styles.navSection}>
          <span className={styles.navSectionLabel}>{section}</span>
          {ADMIN_NAV_ITEMS.filter((item) => item.section === section).map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              onClick={() => setMobileNavOpen(false)}
              className={({ isActive }) => clsx(styles.navItem, isActive && styles.navItemActive)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      ))}

      {moreItems.length > 0 && (
        <div className={styles.navSection}>
          <button
            type="button"
            className={styles.navSectionLabel}
            style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', width: '100%' }}
            onClick={() => setMoreOpen((v) => !v)}
          >
            {moreOpen ? <FiChevronUp size={12} /> : <FiChevronDown size={12} />} More
          </button>
          {moreOpen &&
            moreItems.map((item) => (
              <NavLink
                key={item.id}
                to={item.path}
                onClick={() => setMobileNavOpen(false)}
                className={({ isActive }) => clsx(styles.navItem, isActive && styles.navItemActive)}
              >
                <item.icon size={16} />
                <span>{item.label}</span>
              </NavLink>
            ))}
        </div>
      )}
    </nav>
  );

  return (
    <div className={styles.shell}>
      {!isMobile && (
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <img src="/haive-logo.png" alt="" className={styles.brandMarkImg} />
            </span>
            <div>
              <div className={styles.brandTitle}>Haive Admin</div>
              <div className={styles.brandSubtitle}>Platform Control</div>
            </div>
          </div>
          {nav}
        </aside>
      )}

      <div className={styles.mainColumn}>
        <header className={styles.topbar}>
          {isMobile && (
            <button
              type="button"
              className={styles.menuButton}
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <FiMenu size={18} />
            </button>
          )}
          <div className={styles.topbarTitle}>Haive Platform Admin</div>
          <Dropdown
            align="right"
            trigger={
              <button type="button" className={styles.userTrigger}>
                <span className={styles.userAvatar}>
                  <FiUser size={14} />
                </span>
                <span className={styles.userName}>{admin?.name ?? 'Admin'}</span>
              </button>
            }
            items={[{ id: 'logout', label: 'Sign out', icon: <FiLogOut size={14} />, danger: true, onSelect: handleLogout }]}
          />
        </header>
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {isMobile && mobileNavOpen && (
        <div className={styles.mobileBackdrop} onClick={() => setMobileNavOpen(false)}>
          <div className={styles.mobileSidebar} onClick={(event) => event.stopPropagation()}>
            <div className={styles.mobileSidebarHeader}>
              <div className={styles.brand}>
                <span className={styles.brandMark}>
                  <img src="/haive-logo.png" alt="" className={styles.brandMarkImg} />
                </span>
                <div>
                  <div className={styles.brandTitle}>Haive Admin</div>
                  <div className={styles.brandSubtitle}>Platform Control</div>
                </div>
              </div>
              <button type="button" className={styles.menuButton} onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
                <FiX size={18} />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}
    </div>
  );
}
