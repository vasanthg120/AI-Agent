import { useAuthStore } from '@/stores/authStore';
import { can, hasFeature } from '@/utils/access';

/**
 * What the signed-in person may do in the Dialer — the same rules the server
 * enforces on /calling and /call-copilot: seeing calls needs Call Copilot
 * (an AI role's features, or call_copilot:view); placing them needs
 * call_copilot:create as well.
 */
export function useDialerAccess() {
  const user = useAuthStore((state) => state.user);
  const canView = !!user && hasFeature(user, 'call_copilot');
  const canPlace = canView && can(user, 'call_copilot', 'create');
  return { user, canView, canPlace };
}
