import { create } from 'zustand';

// Chrome's install prompt (not in TypeScript's DOM types yet).
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface DialerState {
  // Set when a new version of the Dialer is downloaded and waiting: calling it
  // switches to that version and reloads.
  applyUpdate: (() => void) | null;
  // Chrome's "install this app" prompt, kept for when the person asks for it.
  installPrompt: InstallPromptEvent | null;
  setApplyUpdate: (apply: (() => void) | null) => void;
  setInstallPrompt: (event: InstallPromptEvent | null) => void;
}

// What the Dialer's shell knows about itself — not saved anywhere.
export const useDialerStore = create<DialerState>()((set) => ({
  applyUpdate: null,
  installPrompt: null,
  setApplyUpdate: (applyUpdate) => set({ applyUpdate }),
  setInstallPrompt: (installPrompt) => set({ installPrompt }),
}));
