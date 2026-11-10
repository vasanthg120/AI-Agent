import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { isPermissionManaged } from '@/utils/access';
import { ROUTES } from '@/constants/routes';

/** Negative gate — blocks a caller who DOES have `role`. Only agent_user is
 * ever blocked by anything; admin and legacy user roles always fall through. */
export function BlockRole({ role, exceptPermissionList = false }: { role: string; exceptPermissionList?: boolean }) {
  const user = useAuthStore((state) => state.user);
  // Someone with their own permission list may come in where asked (Settings: the
  // tabs inside are filtered and guarded by their permissions).
  if (exceptPermissionList && isPermissionManaged(user)) return <Outlet />;
  if (hasRole(user, role)) {
    return <Navigate to={ROUTES.dashboard} replace />;
  }
  return <Outlet />;
}
