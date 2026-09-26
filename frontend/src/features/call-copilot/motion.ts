import type { Transition, Variants } from 'framer-motion';

// One motion language for the whole Call Copilot screen, so a card sliding in,
// a tab pill gliding across and a list staggering all feel like the same
// product. Every duration is short and every spring is just under critical
// damping — things settle instead of bouncing. (The page wraps itself in
// <MotionConfig reducedMotion="user">, so anyone who asked their OS for less
// motion gets fades instead of movement.)

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 260, damping: 28, mass: 0.9 };
export const SPRING_SNAPPY: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 };

// A block arriving on screen.
export const FADE_UP: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE_OUT } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: EASE_OUT } },
};

// A container whose children arrive one after another.
export function staggerChildren(gap = 0.05, delay = 0.03): Variants {
  return { hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } };
}

// A row appearing in a live list (newest signal, newest suggestion).
export const ROW_IN: Variants = {
  hidden: { opacity: 0, x: -10, scale: 0.98 },
  show: { opacity: 1, x: 0, scale: 1, transition: SPRING_SOFT },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.16 } },
};
