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
const AdminLedgerPage = lazy(() => import('./ledger/AdminLedgerPage').then((m) => ({ default: m.AdminLedgerPage })));
const AdminPaymentsPage = lazy(() => import('./payments/AdminPaymentsPage').then((m) => ({ default: m.AdminPaymentsPage })));
const AdminPlansPage = lazy(() => import('./catalog/AdminPlansPage').then((m) => ({ default: m.AdminPlansPage })));
const AdminCreditPackagesPage = lazy(() => import('./catalog/AdminCreditPackagesPage').then((m) => ({ default: m.AdminCreditPackagesPage })));
const AdminFeaturesPage = lazy(() => import('./catalog/AdminFeaturesPage').then((m) => ({ default: m.AdminFeaturesPage })));
const AdminEntitlementsPage = lazy(() => import('./catalog/AdminEntitlementsPage').then((m) => ({ default: m.AdminEntitlementsPage })));
const AdminPricesPage = lazy(() => import('./catalog/AdminPricesPage').then((m) => ({ default: m.AdminPricesPage })));
const AdminCouponsPage = lazy(() => import('./catalog/AdminCouponsPage').then((m) => ({ default: m.AdminCouponsPage })));
const AdminSubscriptionsPage = lazy(() => import('./subscriptions/AdminSubscriptionsPage').then((m) => ({ default: m.AdminSubscriptionsPage })));
const AdminRefundsPage = lazy(() => import('./refunds/AdminRefundsPage').then((m) => ({ default: m.AdminRefundsPage })));
const AdminInvoicesPage = lazy(() => import('./invoices/AdminInvoicesPage').then((m) => ({ default: m.AdminInvoicesPage })));
const AdminAnalyticsPage = lazy(() => import('./AdminAnalyticsPage').then((m) => ({ default: m.AdminAnalyticsPage })));
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
export function AdminRoutes() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<AdminPublicOnlyRoute />}>
          <Route path="signin" element={<AdminSignInPage />} />
        </Route>

        <Route element={<AdminProtectedRoute />}>
          <Route element={<AdminLayout />}>
            <Route index element={<Navigate to={ADMIN_ROUTES.dashboard.replace(ADMIN_ROUTES.root, '')} replace />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="organizations" element={<AdminOrganizationsPage />} />
            <Route path="organizations/:organizationId" element={<AdminOrganizationDetailPage />} />
            <Route path="plans" element={<AdminPlansPage />} />
            <Route path="packages" element={<AdminCreditPackagesPage />} />
            <Route path="features" element={<AdminFeaturesPage />} />
            <Route path="entitlements" element={<AdminEntitlementsPage />} />
            <Route path="prices" element={<AdminPricesPage />} />
            <Route path="subscriptions" element={<AdminSubscriptionsPage />} />
            <Route path="payments" element={<AdminPaymentsPage />} />
            <Route path="payment-settings" element={<AdminPaymentSettingsPage />} />
            <Route path="ledger" element={<AdminLedgerPage />} />
            <Route path="coupons" element={<AdminCouponsPage />} />
            <Route path="refunds" element={<AdminRefundsPage />} />
            <Route path="invoices" element={<AdminInvoicesPage />} />
            <Route path="analytics" element={<AdminAnalyticsPage />} />
            <Route path="admin-users" element={<AdminUsersManagementPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to={ADMIN_ROUTES.dashboard.replace(ADMIN_ROUTES.root, '')} replace />} />
      </Routes>
    </Suspense>
  );
}
