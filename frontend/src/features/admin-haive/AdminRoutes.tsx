import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { ADMIN_ROUTES } from '@/constants/routes';
import { AdminProtectedRoute, AdminPublicOnlyRoute } from './AdminProtectedRoute';

const AdminLayout = lazy(() => import('./layout/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const AdminSignInPage = lazy(() => import('./AdminSignInPage').then((m) => ({ default: m.AdminSignInPage })));
const AdminDashboardPage = lazy(() => import('./AdminDashboardPage').then((m) => ({ default: m.AdminDashboardPage })));
const AdminOrganizationsPage = lazy(() => import('./organizations/AdminOrganizationsPage').then((m) => ({ default: m.AdminOrganizationsPage })));
const AdminOrganizationDetailPage = lazy(() =>
  import('./organizations/AdminOrganizationDetailPage').then((m) => ({ default: m.AdminOrganizationDetailPage })),
);
const AdminPaymentsPage = lazy(() => import('./payments/AdminPaymentsPage').then((m) => ({ default: m.AdminPaymentsPage })));
const AdminPlansPage = lazy(() => import('./catalog/AdminPlansPage').then((m) => ({ default: m.AdminPlansPage })));
const AdminSubscriptionsPage = lazy(() => import('./subscriptions/AdminSubscriptionsPage').then((m) => ({ default: m.AdminSubscriptionsPage })));
const AdminInvoicesPage = lazy(() => import('./invoices/AdminInvoicesPage').then((m) => ({ default: m.AdminInvoicesPage })));
const AdminAnalyticsPage = lazy(() => import('./AdminAnalyticsPage').then((m) => ({ default: m.AdminAnalyticsPage })));
const AdminAiUsagePage = lazy(() => import('./AdminAiUsagePage').then((m) => ({ default: m.AdminAiUsagePage })));
const AdminPaymentSettingsPage = lazy(() => import('./AdminPaymentSettingsPage').then((m) => ({ default: m.AdminPaymentSettingsPage })));
const AdminUsersManagementPage = lazy(() => import('./AdminUsersManagementPage').then((m) => ({ default: m.AdminUsersManagementPage })));
const AdminSettingsPage = lazy(() => import('./AdminSettingsPage').then((m) => ({ default: m.AdminSettingsPage })));

function Fallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240 }}>
      <Spinner size={28} />
    </div>
  );
}

// Self-contained subtree — mounted once at /Admin-haive/* in the top-level
// routes/index.tsx, entirely outside AppLayout/ProtectedRoute.
//
// Features, Entitlements, Prices & Currencies, Coupons, Refunds, and Credit
// Ledger routes were removed here per an explicit request to drop these
// admin surfaces (see adminNav.ts's own comment) — their page components
// (catalog/AdminFeaturesPage.tsx, catalog/AdminEntitlementsPage.tsx,
// catalog/AdminPricesPage.tsx, catalog/AdminCouponsPage.tsx,
// refunds/AdminRefundsPage.tsx, ledger/AdminLedgerPage.tsx) and every backend
// controller/service/schema behind them are untouched; visiting one of these
// URLs directly now just falls through to the catch-all redirect below,
// exactly like any other unknown /Admin-haive/* path.
export function AdminRoutes() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<AdminPublicOnlyRoute />}>
          <Route path="signin" element={<AdminSignInPage />} />
        </Route>

        <Route element={<AdminProtectedRoute />}>
          <Route element={<AdminLayout />}>
            {/* Relative "dashboard" (matching the sibling route's own path
                below), NOT ADMIN_ROUTES.dashboard.replace(root, '') — that
                leaves a leading slash ("/dashboard"), which <Navigate>
                treats as an ABSOLUTE path to the customer app's /dashboard
                route, not /Admin-haive/dashboard. Found live: this exact
                mistake was also on the catch-all route below. */}
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="organizations" element={<AdminOrganizationsPage />} />
            <Route path="organizations/:organizationId" element={<AdminOrganizationDetailPage />} />
            <Route path="plans" element={<AdminPlansPage />} />
            <Route path="subscriptions" element={<AdminSubscriptionsPage />} />
            <Route path="payments" element={<AdminPaymentsPage />} />
            <Route path="payment-settings" element={<AdminPaymentSettingsPage />} />
            <Route path="invoices" element={<AdminInvoicesPage />} />
            <Route path="analytics" element={<AdminAnalyticsPage />} />
            <Route path="ai-usage" element={<AdminAiUsagePage />} />
            <Route path="admin-users" element={<AdminUsersManagementPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
          </Route>
        </Route>

        {/* Must be an ABSOLUTE path (ADMIN_ROUTES.dashboard, already
            "/Admin-haive/dashboard"), not a relative "dashboard" — a
            catch-all's matched path IS the unmatched segment (e.g.
            "features"), so a relative target here resolves by appending
            ("/Admin-haive/features/dashboard"), which then itself falls
            through to this same catch-all again: an infinite redirect loop,
            confirmed live before this fix. The index route above is
            different — it matches its parent exactly with no extra
            segment, so relative "dashboard" there correctly replaces it. */}
        <Route path="*" element={<Navigate to={ADMIN_ROUTES.dashboard} replace />} />
      </Routes>
    </Suspense>
  );
}
