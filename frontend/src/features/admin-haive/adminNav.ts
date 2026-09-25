import type { IconType } from 'react-icons';
import { FiBarChart2, FiCpu, FiCreditCard, FiFileText, FiGrid, FiLayers, FiRefreshCw, FiSettings, FiShield, FiUsers } from 'react-icons/fi';
import { ADMIN_ROUTES } from '@/constants/routes';

export interface AdminNavItem {
  id: string;
  label: string;
  path: string;
  icon: IconType;
  section: 'Overview' | 'Customers' | 'Catalog' | 'Billing' | 'Wallet' | 'Platform' | 'More';
}

// Wallets and Audit Logs were removed from here deliberately — day-to-day
// admin work doesn't need them in the primary nav. Both pages and every
// backend route behind them (GET /billing/admin/wallets, GET
// /audit-logs/all) are untouched, just unreachable via the sidebar/routes.
//
// Features, Entitlements, Prices & Currencies, Coupons, Refunds, and Credit
// Ledger were removed from the nav the same way, per an explicit request to
// drop these admin surfaces — their page components, routes, and backend
// controllers/services/schemas are all left completely untouched (see
// AdminRoutes.tsx's own comment), since other real flows still depend on the
// underlying data (e.g. Credit Packages back the customer-facing Add Credits
// catalog, Currencies populate the Plan price form's currency dropdown).
// Only the ability to manage them via a dedicated admin page is gone; this
// is trivially reversible by re-adding the nav item and route.
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: ADMIN_ROUTES.dashboard, icon: FiGrid, section: 'Overview' },
  { id: 'analytics', label: 'Analytics', path: ADMIN_ROUTES.analytics, icon: FiBarChart2, section: 'Overview' },
  { id: 'ai-usage', label: 'AI Usage', path: ADMIN_ROUTES.aiUsage, icon: FiCpu, section: 'Overview' },

  { id: 'organizations', label: 'Organizations', path: ADMIN_ROUTES.organizations, icon: FiUsers, section: 'Customers' },

  { id: 'plans', label: 'Plans', path: ADMIN_ROUTES.plans, icon: FiLayers, section: 'Catalog' },

  { id: 'subscriptions', label: 'Subscriptions', path: ADMIN_ROUTES.subscriptions, icon: FiRefreshCw, section: 'Billing' },
  { id: 'payments', label: 'Payments', path: ADMIN_ROUTES.payments, icon: FiCreditCard, section: 'Billing' },
  { id: 'payment-settings', label: 'Payment Settings', path: ADMIN_ROUTES.paymentSettings, icon: FiSettings, section: 'Billing' },

  { id: 'admin-users', label: 'Admin Users', path: ADMIN_ROUTES.adminUsers, icon: FiShield, section: 'Platform' },
  { id: 'settings', label: 'Settings', path: ADMIN_ROUTES.settings, icon: FiSettings, section: 'Platform' },

  { id: 'invoices', label: 'Invoices', path: ADMIN_ROUTES.invoices, icon: FiFileText, section: 'More' },
];

// 'Wallet' dropped — Credit Ledger was its only item and is no longer in the
// nav (see ADMIN_NAV_ITEMS' own comment); AdminLayout.tsx renders one block
// per section here with no empty-section guard, so an item-less section
// would otherwise show a bare "WALLET" label with nothing under it.
export const ADMIN_NAV_SECTIONS: AdminNavItem['section'][] = ['Overview', 'Customers', 'Catalog', 'Billing', 'Platform'];

// Rendered as a single collapsed-by-default disclosure at the bottom of the
// sidebar (see AdminLayout.tsx) rather than an always-visible section.
export const ADMIN_NAV_MORE_SECTION: AdminNavItem['section'] = 'More';
