import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAdminAuthStore } from '@/stores/adminAuthStore';
import { ADMIN_ROUTES } from '@/constants/routes';

// Its own session (useAdminAuthStore) — a genuinely separate credential from
// the rest of the app, not just a separate UI area over the same login.
// Backend enforcement is independent and authoritative (every
// /Admin-haive-facing route is gated by AdminJwtAuthGuard server-side);
// this guard only spares an unauthenticated visitor the flash of an admin
// shell they have no data access to.
export function AdminProtectedRoute() {
  const isAuthenticated = useAdminAuthStore((state) => state.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to={ADMIN_ROUTES.signin} replace state={{ from: location }} />;
  }

  return <Outlet />;
}

export function AdminPublicOnlyRoute() {
  const isAuthenticated = useAdminAuthStore((state) => state.isAuthenticated);

  if (isAuthenticated) {
    return <Navigate to={ADMIN_ROUTES.dashboard} replace />;
  }

  return <Outlet />;
}
