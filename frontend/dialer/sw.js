// HaiVE Dialer's service worker, scope /dialer/ only — the main app's /sw.js
// (scope /, push notifications) is a separate registration and is untouched.
//
// The build (vite.config.ts, haiveDialer) fills in VERSION and PRECACHE: the
// Dialer's page and every file it loads. A new build means a new VERSION, so the
// browser installs the new worker beside the old one; it waits until the
// person taps "Refresh" (never mid-call), then takes over and the page reloads.
//
// Kept: the app's own files. Never kept: anything from the API (/api/, and the
// separate API address used in development) or live connections (/socket.io/).

const VERSION = 'dev';
const PRECACHE = [];
const CACHE = `haive-dialer-${VERSION}`;
const SHELL = '/dialer/index.html';

// Only when nothing at all has been kept yet (the very first visit was offline).
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HaiVE Dialer</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#fff;color:#070707;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#0b0b0c;color:#f2f0ea}}button{font:inherit;padding:12px 20px;border-radius:999px;border:0;background:#ed7e2c;color:#070707;min-height:44px}</style></head>
<body><main><h1 style="font-size:20px">You're offline</h1><p>HaiVE Dialer needs the internet the first time it opens.</p><button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('haive-dialer-') && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

// The page asks for this when the person chooses "Refresh" on the update banner.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  if (request.mode === 'navigate') {
    // The app shell straight from the cache: it opens at once, online or not.
    event.respondWith(
      (async () => {
        const cached = await caches.match(SHELL);
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/dialer/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // Built files are named by their content and never change: keep any the list missed.
        if (response.ok && url.pathname.startsWith('/assets/')) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
