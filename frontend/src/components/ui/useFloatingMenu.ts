import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export interface FloatingPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const GAP = 6;
const EDGE = 12;
const PREFERRED_HEIGHT = 320;

// A menu that floats above the page (rendered into document.body), anchored to
// the control that opened it. Inside a scrolling table, a collapsing list or a
// modal, an absolutely positioned menu is cut off by whatever it sits in — the
// Deal Assignment "Choose users" menus were. This places the menu under the
// control (above it when there is no room below), never past the screen's
// edges, follows the control while the page scrolls, and closes on a click
// anywhere outside both the control and the menu.
export function useFloatingMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  minWidth = 220,
): FloatingPosition | null {
  const [position, setPosition] = useState<FloatingPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const width = Math.min(Math.max(rect.width, minWidth), viewportW - EDGE * 2);
      const left = Math.min(Math.max(EDGE, rect.left), viewportW - EDGE - width);
      const below = viewportH - rect.bottom - GAP - EDGE;
      const above = rect.top - GAP - EDGE;
      if (below >= Math.min(PREFERRED_HEIGHT, 200) || below >= above) {
        setPosition({ top: rect.bottom + GAP, left, width, maxHeight: Math.max(120, Math.min(PREFERRED_HEIGHT, below)) });
      } else {
        setPosition({ bottom: viewportH - rect.top + GAP, left, width, maxHeight: Math.max(120, Math.min(PREFERRED_HEIGHT, above)) });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, minWidth]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Only the menu closes — not the modal or drawer it was opened in.
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, anchorRef, menuRef, onClose]);

  return position;
}
