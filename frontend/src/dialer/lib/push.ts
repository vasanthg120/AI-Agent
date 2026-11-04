import { axiosClient } from '@/api/axiosClient';
import { isIos, isStandalone } from './install';

// "Tell me when a call report is ready": a push subscription made on the
// Dialer's own service worker and saved as the Dialer's (app: 'dialer'), so it
// gets that message and nothing else. HaiVE's own push (Settings →
// Notifications, /sw.js) is separate and unchanged.

export type PushState = 'unsupported' | 'install_first' | 'blocked' | 'off' | 'on';

function urlBase64ToBytes(base64Url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = window.atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration('/dialer/');
}

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhones only offer push to apps added to the Home Screen.
    return isIos() && !isStandalone() ? 'install_first' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const subscription = await (await registration())?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** Asks for permission and subscribes; throws a sentence to show when it can't. */
export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('Install the Dialer (or open it once more) to turn on notifications.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for the Dialer in this browser’s settings.');
  const { data } = await axiosClient.get<{ publicKey: string }>('/notifications/push/vapid-public-key');
  if (!data.publicKey) throw new Error('Notifications aren’t set up on this HaiVE server yet. Ask an administrator.');
  const subscription = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(data.publicKey) }));
  await axiosClient.post('/notifications/push/subscribe', { ...subscription.toJSON(), app: 'dialer' });
}

export async function disablePush(): Promise<void> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await axiosClient.post('/notifications/push/unsubscribe', { endpoint });
}
