import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { workAutomationService } from '@/services/workAutomationService';

// Once per signed-in person per browser tab: ask the server to refresh their
// assigned work from every connected platform. The server throttles repeats
// (an organization setting), so this is safe to fire on every open; failures
// are silent because the To-Do still shows what was collected before.
const requested = new Set<string>();

/** True the first time it is asked about this person in this tab. Exposed for tests. */
export function shouldSyncFor(userId: string | undefined, seen: Set<string> = requested): boolean {
  if (!userId || seen.has(userId)) return false;
  seen.add(userId);
  return true;
}

export function useWorkSyncOnOpen() {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!shouldSyncFor(userId)) return;
    workAutomationService
      .syncMe()
      .then(() => queryClient.invalidateQueries({ queryKey: ['work-day'] }))
      .catch(() => undefined);
  }, [userId, queryClient]);
}
