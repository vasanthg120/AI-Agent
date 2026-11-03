import { useQuery } from '@tanstack/react-query';
import { usersService } from '@/services/usersService';

// The Users page's three reads. 'users' is shared with every other page that
// lists people (Calling, Deal Assignment…), so a change here refreshes them too.

export function useUsersList() {
  return useQuery({ queryKey: ['users'], queryFn: usersService.list });
}

/** The server's list of pages and actions — it only changes with a new release. */
export function usePermissionCatalog() {
  return useQuery({ queryKey: ['permission-catalog'], queryFn: usersService.permissionCatalog, staleTime: Infinity });
}

/** The active AI roles a person can be given, with where each one starts them. */
export function useAssignableAiRoles(enabled = true) {
  return useQuery({ queryKey: ['users', 'ai-roles'], queryFn: usersService.aiRoles, enabled });
}
