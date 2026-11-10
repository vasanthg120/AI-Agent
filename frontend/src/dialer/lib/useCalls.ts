import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { callingService, type CallingCall } from '@/services/callingService';

export const CALLS_QUERY_KEY = ['dialer', 'calls'];
// The server sends at most this many calls at a time (calling.service CALL_LOG_LIMIT).
const PAGE_SIZE = 30;
// After hangup the recording takes a little while to arrive.
const RECORDING_WAIT_MS = 10 * 60_000;

/** Still changing: being set up, live, or its report still being made. */
export function isCallMoving(call: CallingCall): boolean {
  const stage = call.outcome?.stage;
  if (stage === 'ringing_agent' || stage === 'connecting_customer' || stage === 'in_call') return true;
  if (stage !== 'ended') return false;
  if (call.report) return call.report.stage === 'transcribing' || call.report.stage === 'scoring';
  if (call.importStatus === 'pending') return true;
  return call.importStatus === 'none' && Date.now() - new Date(call.updatedAt).getTime() < RECORDING_WAIT_MS;
}

/** My calls, newest first, a page at a time — refreshed often while any is still moving. */
export function useCalls() {
  const query = useInfiniteQuery({
    queryKey: CALLS_QUERY_KEY,
    queryFn: ({ pageParam }) => callingService.listCalls('mine', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length >= PAGE_SIZE ? last[last.length - 1].createdAt : undefined),
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.pages[0]?.some(isCallMoving) ? 5000 : 60_000),
  });
  const calls = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flat() ?? []).filter((call) => !seen.has(call.id) && seen.add(call.id));
  }, [query.data]);
  return { ...query, calls };
}
