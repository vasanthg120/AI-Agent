import type { Transition } from 'framer-motion';

// One shared "smooth popup" motion language for every overlay in the app —
// Modal, Dropdown, InfoPopover, the month/year and multi-select filter
// panels, the Command Palette, and Tooltip all animate open/close with
// these, instead of each component inventing its own timing.
//
// Short tweens with a strong ease-out, not springs: a spring keeps moving by
// sub-pixel amounts for several hundred milliseconds after it looks finished,
// and during that tail the overlay still intercepts clicks and repaints every
// frame — which is what made menus and dialogs feel sticky ("I clicked, why
// hasn't it responded?") and shimmer on slower machines. A tween is done when
// it says it is.

const EASE_OUT: [number, number, number, number] = [0.2, 0.9, 0.3, 1];

// The large surfaces — Modal's panel, the Command Palette.
export const SURFACE_SPRING: Transition = { duration: 0.2, ease: EASE_OUT };

// Backdrop fade behind a full-screen overlay (Modal, Command Palette).
export const BACKDROP_FADE: Transition = { duration: 0.16, ease: 'easeOut' };

// Small anchored popups — Dropdown menus, InfoPopover, the month/year and
// multi-select filter panels. They open far more often and sit right under
// the cursor, so they are quicker still.
export const POPUP_SPRING: Transition = { duration: 0.14, ease: EASE_OUT };

// Tooltips should feel instant on hover.
export const TOOLTIP_SPRING: Transition = { duration: 0.1, ease: 'easeOut' };
