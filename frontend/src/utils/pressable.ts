import type { KeyboardEvent } from 'react';

// Props that make a non-button element (a bar, a stat, a chart row) behave
// like a real button: focusable, announced as a button, and activated by
// Enter/Space as well as a click. A bare role="button" + tabIndex without the
// key handler takes focus but then does nothing on Enter — a keyboard trap.
export function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
  };
}
