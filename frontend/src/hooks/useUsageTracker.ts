import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { env } from '@/config/env';
import { areaOfPath } from '@/features/team-activity/usageAreas';
import { useAuthStore } from '@/stores/authStore';

/** No click, key press, scroll or touch for this long: the person has stepped away. */
const IDLE_MS = 2 * 60_000;
const TICK_MS = 1000;
const SEND_EVERY_MS = 60_000;
const MINUTE = 60_000;
/** The server takes this many minutes per request; older ones left over (a long time offline) are dropped. */
const MAX_BEATS = 240;

interface Pending {
  minute: number;
  area: string;
  ms: number;
}

// Employee Activity's measured time in HaiVE. A second counts only when the HaiVE
// tab is in front, its window has focus, and the person clicked, typed, scrolled or
// touched in the last two minutes — an open tab nobody touches counts for nothing.
// Each minute's seconds are kept per part of the app (usageAreas) and sent once a
// minute as running totals: the server keeps the larger of what it already has, so
// sending again, or two tabs on one page, never adds up twice. What is still unsent
// goes when the tab is hidden or closed, and with the old sign-in when the person
// switches business.
export function useUsageTracker(): void {
  const token = useAuthStore((s) => s.accessToken);
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    if (!token) return;
    let lastInput = Date.now();
    let lastTick = Date.now();
    let refused = false;
    const pending = new Map<string, Pending>();

    const onInput = () => {
      lastInput = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
    for (const name of events) window.addEventListener(name, onInput, { passive: true, capture: true });

    const tick = window.setInterval(() => {
      const now = Date.now();
      // Never more than two seconds for one tick: a sleeping laptop wakes without a gift of hours.
      const elapsed = Math.min(now - lastTick, 2 * TICK_MS);
      lastTick = now;
      const active = document.visibilityState === 'visible' && document.hasFocus() && now - lastInput < IDLE_MS;
      if (!active || elapsed <= 0) return;
      const minute = Math.floor(now / MINUTE) * MINUTE;
      const area = areaOfPath(pathRef.current);
      const key = `${minute}|${area}`;
      const entry = pending.get(key) ?? { minute, area, ms: 0 };
      entry.ms = Math.min(MINUTE, entry.ms + elapsed);
      pending.set(key, entry);
    }, TICK_MS);

    const send = (keepalive: boolean) => {
      if (refused || pending.size === 0) return;
      const entries = [...pending.values()].filter((e) => e.ms >= 1000).sort((a, b) => a.minute - b.minute);
      if (entries.length === 0) return;
      const batch = entries.slice(-MAX_BEATS);
      const currentMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
      const body = JSON.stringify({
        sentAt: new Date().toISOString(),
        beats: batch.map((e) => ({ minute: new Date(e.minute).toISOString(), area: e.area, seconds: Math.min(60, Math.round(e.ms / 1000)) })),
      });
      void fetch(`${env.apiUrl}/employee-activity/usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
        keepalive,
      })
        .then((response) => {
          // A sign-in that is no longer valid: stop until the next one (the rest of the app handles signing out).
          if (response.status === 401 || response.status === 403) refused = true;
          if (!response.ok) return;
          // Finished minutes are done (sent, or too small or too old to send); the current one
          // keeps counting and goes again with its new total.
          for (const [key, e] of pending) if (e.minute < currentMinute) pending.delete(key);
        })
        .catch(() => undefined); // offline: kept for the next try
    };

    const every = window.setInterval(() => send(false), SEND_EVERY_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') send(true);
    };
    const onPageHide = () => send(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(every);
      for (const name of events) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      // Signed out or switched business: what was measured goes with the sign-in it belongs to.
      send(true);
    };
  }, [token]);
}
