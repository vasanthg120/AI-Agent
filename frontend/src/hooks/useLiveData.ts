import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { liveDataService, type LiveScope, type LiveStatus } from '@/services/liveDataService';

// While a read is under way the page looks again this often, for at most this long
// (a CRM that must be read whole can take a couple of minutes).
const WATCH_EVERY_MS = 4_000;
const WATCH_FOR_MS = 4 * 60_000;
// Coming back to a tab that was hidden at least this long asks the sources again.
const RETURN_AFTER_MS = 30_000;

export interface UseLiveDataOptions {
  /** 'all': every business (the Main Account owner's all-businesses views). */
  scope?: LiveScope;
  /** Ask the CRMs (default true). */
  crm?: boolean;
  /** Ask the mailbox for new mail and replies too (no AI). */
  email?: boolean;
  /** The queries to reload when a read lands — 'all': every query on screen (totals pages). */
  invalidate: QueryKey[] | 'all';
  /** Ask again this often while the page is visible — the inbox only; other pages ask when opened. */
  repeatMs?: number;
  enabled?: boolean;
}

export interface LiveData {
  status?: LiveStatus;
  /** A source or the mailbox is being read, or the AI is reading new mail. */
  busy: boolean;
  /** Ask again now (e.g. "Try again"). */
  refresh: () => void;
}

const isBusy = (s?: LiveStatus) => !!s && (s.sources.some((x) => x.refreshing) || !!s.mailbox?.fetching || !!s.mailbox?.aiReading);

// What, when it changes, means the page's figures changed.
const signature = (s: LiveStatus) =>
  [
    ...s.sources.map((x) => `${x.id}:${x.lastSyncAt ?? ''}`),
    s.mailbox ? `mail:${s.mailbox.lastFetchedAt ?? ''}:${s.mailbox.awaitingAi}:${s.mailbox.aiReading}` : '',
  ].join('|');

/**
 * Live source data for a page: on open (and on coming back to the tab) the server asks each
 * live source for what changed; while those reads run the page watches, and the moment one
 * lands its queries reload. No timer between visits — except the inbox's `repeatMs`.
 */
export function useLiveData({ scope = 'business', crm = true, email = false, invalidate, repeatMs, enabled = true }: UseLiveDataOptions): LiveData {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>();
  const seen = useRef<string | null>(null);
  const keys = useRef(invalidate);
  keys.current = invalidate;
  const watchTimer = useRef<number | undefined>(undefined);
  const watchUntil = useRef(0);
  const lastAsked = useRef(0);
  const alive = useRef(true);

  const apply = useCallback(
    (next: LiveStatus) => {
      const sig = signature(next);
      if (seen.current !== null && seen.current !== sig) {
        if (keys.current === 'all') void queryClient.invalidateQueries();
        else for (const queryKey of keys.current) void queryClient.invalidateQueries({ queryKey });
      }
      seen.current = sig;
      setStatus(next);
    },
    [queryClient],
  );

  const watch = useCallback(
    (delay = WATCH_EVERY_MS) => {
      window.clearTimeout(watchTimer.current);
      watchTimer.current = window.setTimeout(async () => {
        if (!alive.current) return;
        try {
          const next = await liveDataService.status(scope, email);
          if (!alive.current) return;
          apply(next);
          if (isBusy(next) && Date.now() < watchUntil.current) watch();
        } catch {
          // Quiet: the page still shows the last figures and when they were read.
        }
      }, delay);
    },
    [apply, scope, email],
  );

  const ask = useCallback(async () => {
    lastAsked.current = Date.now();
    watchUntil.current = Date.now() + WATCH_FOR_MS;
    try {
      const next = await liveDataService.refresh(scope, email, crm);
      if (!alive.current) return;
      apply(next);
      // The mailbox read starts a moment after the answer: look once more even if nothing shows yet.
      if (isBusy(next) || email) watch(email && !isBusy(next) ? 2_500 : WATCH_EVERY_MS);
    } catch {
      // Quiet, as above.
    }
  }, [apply, watch, scope, email, crm]);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    seen.current = null;
    void ask();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAsked.current >= RETURN_AFTER_MS) void ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    const repeat = repeatMs
      ? window.setInterval(() => {
          if (document.visibilityState === 'visible') void ask();
        }, repeatMs)
      : undefined;
    return () => {
      alive.current = false;
      window.clearTimeout(watchTimer.current);
      window.clearInterval(repeat);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ask, enabled, repeatMs]);

  return { status, busy: isBusy(status), refresh: () => void ask() };
}
