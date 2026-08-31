import type { IconType } from 'react-icons';
import {
  FiActivity,
  FiBarChart2,
  FiCheckSquare,
  FiCreditCard,
  FiFileText,
  FiGift,
  FiGrid,
  FiLayers,
  FiPercent,
  FiRefreshCw,
  FiSettings,
  FiShield,
  FiTag,
  FiUsers,
} from 'react-icons/fi';
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
// Features, Prices & Currencies, Coupons, Refunds, and Invoices moved into
// the 'More' section (rendered collapsed by default in AdminLayout) for the
// same reason — day-to-day plan/package/payment work doesn't need them
// front and center, but every page and route stays fully reachable.
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: ADMIN_ROUTES.dashboard, icon: FiGrid, section: 'Overview' },
  { id: 'analytics', label: 'Analytics', path: ADMIN_ROUTES.analytics, icon: FiBarChart2, section: 'Overview' },

  { id: 'organizations', label: 'Organizations', path: ADMIN_ROUTES.organizations, icon: FiUsers, section: 'Customers' },

  { id: 'plans', label: 'Plans', path: ADMIN_ROUTES.plans, icon: FiLayers, section: 'Catalog' },
  { id: 'packages', label: 'Credit Packages', path: ADMIN_ROUTES.packages, icon: FiGift, section: 'Catalog' },

  { id: 'subscriptions', label: 'Subscriptions', path: ADMIN_ROUTES.subscriptions, icon: FiRefreshCw, section: 'Billing' },
  { id: 'payments', label: 'Payments', path: ADMIN_ROUTES.payments, icon: FiCreditCard, section: 'Billing' },
  { id: 'payment-settings', label: 'Payment Settings', path: ADMIN_ROUTES.paymentSettings, icon: FiSettings, section: 'Billing' },

  { id: 'ledger', label: 'Credit Ledger', path: ADMIN_ROUTES.ledger, icon: FiActivity, section: 'Wallet' },

  { id: 'admin-users', label: 'Admin Users', path: ADMIN_ROUTES.adminUsers, icon: FiShield, section: 'Platform' },
  { id: 'settings', label: 'Settings', path: ADMIN_ROUTES.settings, icon: FiSettings, section: 'Platform' },

  { id: 'features', label: 'Features', path: ADMIN_ROUTES.features, icon: FiTag, section: 'More' },
  { id: 'entitlements', label: 'Entitlements', path: ADMIN_ROUTES.entitlements, icon: FiCheckSquare, section: 'More' },
  { id: 'prices', label: 'Prices & Currencies', path: ADMIN_ROUTES.prices, icon: FiPercent, section: 'More' },
  { id: 'coupons', label: 'Coupons', path: ADMIN_ROUTES.coupons, icon: FiTag, section: 'More' },
  { id: 'refunds', label: 'Refunds', path: ADMIN_ROUTES.refunds, icon: FiRefreshCw, section: 'More' },
  { id: 'invoices', label: 'Invoices', path: ADMIN_ROUTES.invoices, icon: FiFileText, section: 'More' },
];

export const ADMIN_NAV_SECTIONS: AdminNavItem['section'][] = ['Overview', 'Customers', 'Catalog', 'Billing', 'Wallet', 'Platform'];

// Rendered as a single collapsed-by-default disclosure at the bottom of the
// sidebar (see AdminLayout.tsx) rather than an always-visible section.
export const ADMIN_NAV_MORE_SECTION: AdminNavItem['section'] = 'More';
