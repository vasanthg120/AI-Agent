import { useDialerStore, type InstallPromptEvent } from './dialerStore';

const DISMISSED_KEY = 'haive-dialer:install-dismissed';

/** Opened from the home screen (or as an installed desktop app). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** An iPhone or iPad, which has no install prompt: people add it from Safari's Share menu. */
export function isIos(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function installDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstall() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: it just shows again next time.
  }
}

// Chrome offers to install once it decides the page qualifies; keep the offer
// for the "Install" button instead of its own mini-bar.
export function listenForInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    useDialerStore.getState().setInstallPrompt(event as InstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => useDialerStore.getState().setInstallPrompt(null));
}

/** Shows Chrome's install dialog; true when the person installed it. */
export async function promptInstall(): Promise<boolean> {
  const event = useDialerStore.getState().installPrompt;
  if (!event) return false;
  await event.prompt();
  const { outcome } = await event.userChoice;
  useDialerStore.getState().setInstallPrompt(null);
  return outcome === 'accepted';
}
