import { useQuery } from '@tanstack/react-query';
import { accountsService } from '@/services/accountsService';
import { useAuthStore } from '@/stores/authStore';

export const ACCOUNTS_QUERY_KEY = ['accounts'];

/** The businesses this login may enter, which one is open, and whether it's locked. */
export function useAccounts() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const query = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: accountsService.list,
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  const current = query.data?.accounts.find((account) => account.isCurrent);
  const home = query.data?.accounts.find((account) => account.isHome);
  return { ...query, current, home, locked: query.data?.locked ?? false };
}
