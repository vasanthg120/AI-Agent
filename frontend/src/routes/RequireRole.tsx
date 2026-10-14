import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { hasFeature, isAiRoleAccount } from '@/utils/access';
import { ROUTES } from '@/constants/routes';

/** Positive gate — only lets a caller through when they DO have `role`
 * (or, when given an array, any one of them). Used for the handful of
 * admin-only pages, and multi-role pages like /deal-performance. */
export function RequireRole({ role, feature }: { role: string | string[]; feature?: string }) {
  const user = useAuthStore((state) => state.user);
  const roles = Array.isArray(role) ? role : [role];
  // An account tied to an AI role gets in when that role includes the page's feature.
  const viaAiRole = !!feature && isAiRoleAccount(user) && hasFeature(user, feature);
  if (!viaAiRole && !roles.some((r) => hasRole(user, r))) {
    return <Navigate to={ROUTES.dashboard} replace />;
  }
  return <Outlet />;
}

/** For pages every ordinary account may open: an account tied to an AI role
 * needs that role to include the feature. */
export function RequireFeature({ feature }: { feature: string }) {
  const user = useAuthStore((state) => state.user);
  if (!hasFeature(user, feature)) {
    return <Navigate to={ROUTES.dashboard} replace />;
  }
  return <Outlet />;
}
