import { useRef } from 'react';
import type { PointerEvent } from 'react';

const LONG_PRESS_MS = 550;

/**
 * A press and a long press on one button. The short press stays a normal click,
 * so Enter/Space and switch access work as on any button; the long press is
 * only ever an extra (each has another way in for those who can't hold).
 */
export function useLongPress(onPress: () => void, onLongPress: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0) return;
      fired.current = false;
      cancel();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    onClick: () => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      onPress();
    },
  };
}
