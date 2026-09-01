import { axiosClient } from '@/api/axiosClient';

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

// PushManager.subscribe's applicationServerKey wants a Uint8Array, not the
// base64url string the backend hands back — unavoidable boilerplate for
// this browser API, no library shortcut for it.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ?? navigator.serviceWorker.register('/sw.js');
}

/** Full subscribe flow: register the service worker (lazy — only ever
 * called from a toggle's onChange, never at app load), request permission,
 * subscribe with this backend's VAPID public key, then POST the
 * subscription so the backend can actually deliver to it. Throws on any
 * failure/denial — the caller (NotificationSettings) is responsible for
 * reverting its toggle and explaining why, never silently persisting a
 * preference the browser can't actually satisfy. */
export async function subscribeToPush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const registration = await getRegistration();
  const { data } = await axiosClient.get<{ publicKey: string }>('/notifications/push/vapid-public-key');
  if (!data.publicKey) {
    throw new Error('Push notifications are not configured on this server.');
  }
  let subscription = await registration.pushManager.getSubscription();

if (!subscription) {
  const keyBytes = urlBase64ToUint8Array(data.publicKey);
  const applicationServerKey = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(applicationServerKey).set(keyBytes);

  subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
}
  await axiosClient.post('/notifications/push/subscribe', subscription.toJSON());
}

/** Client-side unsubscribe (so the browser stops holding a subscription
 * it'll never use) plus the matching server-side removal — a preference
 * flip to "off" without this would leave a stale, still-deliverable
 * subscription sitting in the browser even though the backend no longer
 * has a reason to know about it. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await axiosClient.post('/notifications/push/unsubscribe', { endpoint });
}
