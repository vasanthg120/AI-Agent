import { useDialerStore } from './dialerStore';

// The Dialer's own service worker (frontend/dialer/sw.js, scope /dialer/). The
// main app's /sw.js (push notifications, scope /) is a different registration
// and is left alone. Not in development: Vite serves files that change on every
// save, and a cached shell would only get in the way.
export function registerDialerWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => void register());
}

async function register() {
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register('/dialer/sw.js', { scope: '/dialer/' });
  } catch {
    return; // Private browsing, or blocked: the Dialer works, just not offline.
  }

  // Only reload when the person asked for the new version — the first install
  // also changes the controller, and must not reload the page under them.
  let switching = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (switching) window.location.reload();
  });
  const offer = (worker: ServiceWorker) =>
    useDialerStore.getState().setApplyUpdate(() => {
      switching = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });

  if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) offer(installing);
    });
  });
  // A Dialer left open for days still hears about new versions when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
  });
}
