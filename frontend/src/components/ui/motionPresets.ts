import type { Transition } from 'framer-motion';

// One shared "smooth popup" motion language for every overlay in the app —
// Modal, Dropdown, InfoPopover, the month/year and multi-select filter
// panels, the Command Palette, and Tooltip all animate open/close with
// these, instead of each component inventing its own timing. All three
// springs sit just under critical damping (ratio ~0.9-0.95): each settles
// into place without a visible bounce, but isn't a mechanical linear snap
// either.

// The large surfaces — Modal's panel, the Command Palette. Slightly more
// mass and lower stiffness than POPUP_SPRING so a bigger surface reads as
// having real weight, not the same quick flick as a small menu.
export const SURFACE_SPRING: Transition = { type: 'spring', stiffness: 300, damping: 30, mass: 0.9 };

// Backdrop fade behind a full-screen overlay (Modal, Command Palette).
export const BACKDROP_FADE: Transition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] };

// Small anchored popups — Dropdown menus, InfoPopover, the month/year and
// multi-select filter panels. Snappier than SURFACE_SPRING since these open
// far more often and sit much closer to the cursor/trigger.
export const POPUP_SPRING: Transition = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 };

// Tooltips need to feel near-instant on hover — highest stiffness, lowest
// mass of the three, so it settles well under 100ms.
export const TOOLTIP_SPRING: Transition = { type: 'spring', stiffness: 500, damping: 30, mass: 0.5 };
