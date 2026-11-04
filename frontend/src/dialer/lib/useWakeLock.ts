import { useEffect } from 'react';

/** Keeps the screen on while `active` (a call is live), where the browser allows it.
 * The browser drops the lock whenever the app is hidden; it is asked for again on return. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const request = async () => {
      try {
        const next = await navigator.wakeLock.request('screen');
        if (done) void next.release();
        else lock = next;
      } catch {
        // Battery saver, or not allowed right now: the call goes on regardless.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void request();
    };
    void request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
