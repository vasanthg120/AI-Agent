// A short buzz on phones that can (Android; iPhones don't let web apps vibrate).
const PATTERNS = {
  key: [8],
  start: [20],
  connected: [30, 60, 30],
  ended: [60],
  error: [80, 40, 80],
} as const;

export type Haptic = keyof typeof PATTERNS;

export function haptic(kind: Haptic) {
  try {
    if ('vibrate' in navigator) navigator.vibrate([...PATTERNS[kind]]);
  } catch {
    // Not allowed (no user gesture yet, or turned off): nothing to do.
  }
}
