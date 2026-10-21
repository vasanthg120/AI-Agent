// import { useState } from 'react';
// import { NavLink, Outlet, useNavigate } from 'react-router-dom';
// import { motion } from 'framer-motion';
// import clsx from 'clsx';
// import toast from 'react-hot-toast';
// import { FiChevronDown, FiChevronRight, FiChevronUp, FiLogOut, FiMenu, FiX } from 'react-icons/fi';
// import { Avatar, Dropdown } from '@/components/ui';
// import { useAdminAuthStore } from '@/stores/adminAuthStore';
// import { useMediaQuery } from '@/hooks/useMediaQuery';
// import { ADMIN_ROUTES } from '@/constants/routes';
// import { ADMIN_NAV_ITEMS, ADMIN_NAV_MORE_SECTION, ADMIN_NAV_SECTIONS } from '../adminNav';
// import styles from './AdminLayout.module.css';

// // Same spring as the customer sidebar's animated active-item highlight (see
// // SidebarNav.tsx's PILL_SPRING) — a visual-only match, not shared code,
// // since importing that component would drag in its collapse/hover-card/
// // group-folding behavior this page deliberately isn't adopting.
// const PILL_SPRING = { type: 'spring', stiffness: 420, damping: 38, mass: 0.7 } as const;

// // Deliberately its own shell — not AppLayout — so this area is visually and
// // structurally separate from the customer app, per the request. Reads
// // useAdminAuthStore — a fully separate credential from the customer app's
// // session, not just a separate UI area over the same login.
// export function AdminLayout() {
//   // Matches AppLayout.tsx's own mobile-shell breakpoint (900px) — this was
//   // independently built at 960px with no functional reason to differ.
//   const isMobile = useMediaQuery('(max-width: 900px)');
//   const [mobileNavOpen, setMobileNavOpen] = useState(false);
//   const [moreOpen, setMoreOpen] = useState(false);
//   const admin = useAdminAuthStore((state) => state.admin);
//   const logout = useAdminAuthStore((state) => state.logout);
//   const navigate = useNavigate();

//   const handleLogout = () => {
//     logout();
//     toast.success('Signed out');
//     navigate(ADMIN_ROUTES.signin, { replace: true });
//   };

//   const moreItems = ADMIN_NAV_ITEMS.filter((item) => item.section === ADMIN_NAV_MORE_SECTION);

//   // Same icon-tile + animated gradient "pill" treatment as the customer
//   // sidebar's active-item highlight (SidebarNav.tsx) — rendered here as its
//   // own render-prop body per item, the same shape customer's NavLink uses,
//   // so the active pill can glide between items on navigation.
//   const navLink = (item: (typeof ADMIN_NAV_ITEMS)[number]) => (
//     <NavLink
//       key={item.id}
//       to={item.path}
//       onClick={() => setMobileNavOpen(false)}
//       className={({ isActive }) => clsx(styles.navItem, isActive && styles.navItemActive)}
//     >
//       {({ isActive }) => (
//         <>
//           {isActive && <motion.span layoutId="admin-nav-pill" className={styles.navPill} transition={PILL_SPRING} />}
//           <span className={styles.navIconTile}>
//             <item.icon size={16} className={styles.navIcon} />
//           </span>
//           <span className={styles.navLabel}>{item.label}</span>
//         </>
//       )}
//     </NavLink>
//   );

//   const nav = (
//     <nav className={styles.nav} aria-label="Admin navigation">
//       {ADMIN_NAV_SECTIONS.map((section) => (
//         <div key={section} className={styles.navSection}>
//           <span className={styles.navSectionLabel}>{section}</span>
//           {ADMIN_NAV_ITEMS.filter((item) => item.section === section).map(navLink)}
//         </div>
//       ))}

//       {moreItems.length > 0 && (
//         <div className={styles.navSection}>
//           <button type="button" className={styles.navMoreButton} onClick={() => setMoreOpen((v) => !v)}>
//             {moreOpen ? <FiChevronUp size={12} /> : <FiChevronDown size={12} />} More
//           </button>
//           {moreOpen && moreItems.map(navLink)}
//         </div>
//       )}
//     </nav>
//   );

//   // Same account menu as before (just "Sign out" — admin accounts have no
//   // profile page of their own), relocated from the topbar into a sidebar
//   // footer card — same position, same avatar+name+email+chevron shape, and
//   // the same left/top Dropdown placement, as the customer sidebar's own
//   // footer (Sidebar.tsx). Still just this one dropdown with the same
//   // handleLogout; nothing about what it does changed, only where it lives.
//   const footer = (
//     <div className={styles.footer}>
//       <Dropdown
//         align="left"
//         placement="top"
//         className={styles.userDropdownWrapper}
//         trigger={
//           <button type="button" className={styles.userRow} aria-label="Account menu">
//             <Avatar name={admin?.name ?? 'Admin'} size="sm" />
//             <span className={styles.userText}>
//               <div className={styles.userName}>{admin?.name ?? 'Admin'}</div>
//               <div className={styles.userEmail}>{admin?.email}</div>
//             </span>
//             <FiChevronRight className={styles.userChevron} />
//           </button>
//         }
//         items={[{ id: 'logout', label: 'Sign out', icon: <FiLogOut size={14} />, danger: true, onSelect: handleLogout }]}
//       />
//     </div>
//   );

//   return (
//     <div className={styles.shell}>
//       {!isMobile && (
//         <aside className={styles.sidebar}>
//           <div className={styles.brand}>
//             <span className={styles.brandMark}>
//               <img src="/haive-logo.png" alt="" className={styles.brandMarkImg} />
//             </span>
//             <div>
//               <div className={styles.brandTitle}>Haive Admin</div>
//               <div className={styles.brandSubtitle}>Platform Control</div>
//             </div>
//           </div>
//           {nav}
//           {footer}
//         </aside>
//       )}

//       <div className={styles.mainColumn}>
//         <header className={styles.topbar}>
//           {isMobile && (
//             <button
//               type="button"
//               className={styles.menuButton}
//               onClick={() => setMobileNavOpen(true)}
//               aria-label="Open navigation"
//             >
//               <FiMenu size={18} />
//             </button>
//           )}
//           <div className={styles.topbarTitle}>Haive Platform Admin</div>
//         </header>
//         <main className={styles.content}>
//           <Outlet />
//         </main>
//       </div>

//       {isMobile && mobileNavOpen && (
//         <div className={styles.mobileBackdrop} onClick={() => setMobileNavOpen(false)}>
//           <div className={styles.mobileSidebar} onClick={(event) => event.stopPropagation()}>
//             <div className={styles.mobileSidebarHeader}>
//               <div className={styles.brand}>
//                 <span className={styles.brandMark}>
//                   <img src="/haive-logo.png" alt="" className={styles.brandMarkImg} />
//                 </span>
//                 <div>
//                   <div className={styles.brandTitle}>Haive Admin</div>
//                   <div className={styles.brandSubtitle}>Platform Control</div>
//                 </div>
//               </div>
//               <button type="button" className={styles.menuButton} onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
//                 <FiX size={18} />
//               </button>
//             </div>
//             {nav}
//             {footer}
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }




import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  FiChevronDown,
  FiChevronRight,
  FiChevronUp,
  FiLogOut,
  FiMenu,
  FiX,
} from 'react-icons/fi';

import { Avatar, Dropdown } from '@/components/ui';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ADMIN_ROUTES } from '@/constants/routes';
import {
  ADMIN_NAV_ITEMS,
  ADMIN_NAV_MORE_SECTION,
  ADMIN_NAV_SECTIONS,
} from '../adminNav';

import styles from './AdminLayout.module.css';

const PILL_SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 38,
  mass: 0.7,
} as const;

export function AdminLayout() {
  const isMobile = useMediaQuery('(max-width: 900px)');
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

  const moreItems = ADMIN_NAV_ITEMS.filter(
    (item) => item.section === ADMIN_NAV_MORE_SECTION,
  );

  const navLink = (item: (typeof ADMIN_NAV_ITEMS)[number]) => (
    <NavLink
      key={item.id}
      to={item.path}
      onClick={() => setMobileNavOpen(false)}
      className={({ isActive }) =>
        clsx(styles.navItem, isActive && styles.navItemActive)
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="admin-nav-pill"
              className={styles.navPill}
              transition={PILL_SPRING}
            />
          )}

          <span className={styles.navIconTile}>
            <item.icon size={16} className={styles.navIcon} />
          </span>

          <span className={styles.navLabel}>{item.label}</span>
        </>
      )}
    </NavLink>
  );

  const nav = (
    <nav className={styles.nav} aria-label="Admin navigation">
      {ADMIN_NAV_SECTIONS.map((section) => (
        <div key={section} className={styles.navSection}>
          <span className={styles.navSectionLabel}>{section}</span>

          {ADMIN_NAV_ITEMS
            .filter((item) => item.section === section)
            .map(navLink)}
        </div>
      ))}

      {moreItems.length > 0 && (
        <div className={styles.navSection}>
          <button
            type="button"
            className={styles.navMoreButton}
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
          >
            {moreOpen ? (
              <FiChevronUp size={12} />
            ) : (
              <FiChevronDown size={12} />
            )}
            More
          </button>

          {moreOpen && moreItems.map(navLink)}
        </div>
      )}
    </nav>
  );

  const footer = (
    <div className={styles.footer}>
      <Dropdown
        align="left"
        placement="top"
        className={styles.userDropdownWrapper}
        trigger={
          <button
            type="button"
            className={styles.userRow}
            aria-label="Account menu"
          >
            <Avatar name={admin?.name ?? 'Admin'} size="sm" />

            <span className={styles.userText}>
              <span className={styles.userName}>
                {admin?.name ?? 'Admin'}
              </span>
              <span className={styles.userEmail}>
                {admin?.email ?? ''}
              </span>
            </span>

            <FiChevronRight className={styles.userChevron} />
          </button>
        }
        items={[
          {
            id: 'logout',
            label: 'Sign out',
            icon: <FiLogOut size={14} />,
            danger: true,
            onSelect: handleLogout,
          },
        ]}
      />
    </div>
  );

  const brand = (
    <div className={styles.brand}>
      <span className={styles.brandMark}>
        <img
          src="/haive-logo.png"
          alt=""
          className={styles.brandMarkImg}
        />
      </span>

      <div>
        <div className={styles.brandTitle}>Haive Admin</div>
        <div className={styles.brandSubtitle}>Platform Control</div>
      </div>
    </div>
  );

  return (
    <div className={styles.shell}>
      {!isMobile && (
        <aside className={styles.sidebar}>
          {brand}
          {nav}
          {footer}
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

          <div className={styles.topbarTitle}>
            Haive Platform Admin
          </div>
        </header>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {isMobile && mobileNavOpen && (
        <div
          className={styles.mobileBackdrop}
          onClick={() => setMobileNavOpen(false)}
        >
          <aside
            className={styles.mobileSidebar}
            onClick={(event) => event.stopPropagation()}
            aria-label="Mobile admin navigation"
          >
            <div className={styles.mobileSidebarHeader}>
              {brand}

              <button
                type="button"
                className={styles.menuButton}
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
              >
                <FiX size={18} />
              </button>
            </div>

            {nav}
            {footer}
          </aside>
        </div>
      )}
    </div>
  );
}
