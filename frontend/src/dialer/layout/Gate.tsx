import { lazy, Suspense, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';
import { useDialerAccess } from '../lib/access';
import { useOnline } from '../lib/useOnline';
import { NoAccessScreen } from '../screens/GateScreens';
import { SignInScreen } from '../screens/SignInScreen';

const AUTH_STORAGE_KEY = 'enterprise-ai:auth';
const LockedScreen = lazy(() => import('../screens/LockedScreen').then((m) => ({ default: m.LockedScreen })));

/**
 * Who gets past the front door: signed in (the same session as HaiVE on this
 * browser), in a business that isn't locked, with Call Copilot. The server
 * enforces all of it again on every request; this only decides which screen to
 * show instead of one whose every request would be refused.
 */
export function Gate({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const accessToken = useAuthStore((state) => state.accessToken);
  const online = useOnline();
  const { canView } = useDialerAccess();
  const { locked } = useAccounts();

  // Signing out (or switching business) in HaiVE in another tab changes the
  // Dialer too, rather than leaving it on a session that no longer exists.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_STORAGE_KEY) void useAuthStore.persist.rehydrate();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The saved profile may be days old: what this person may do is read afresh.
  const me = useQuery({
    queryKey: ['dialer', 'me', accessToken],
    queryFn: () => authService.fetchCurrentUser(accessToken!),
    enabled: isAuthenticated && !!accessToken && online,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (me.data) useAuthStore.setState({ user: me.data });
  }, [me.data]);

  if (!isAuthenticated) return <SignInScreen />;
  if (online && locked) {
    return (
      <Suspense fallback={null}>
        <LockedScreen />
      </Suspense>
    );
  }
  if (!canView) return <NoAccessScreen />;
  return <>{children}</>;
}
