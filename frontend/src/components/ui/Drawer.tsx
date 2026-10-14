import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Transition, Variants } from 'framer-motion';
import { FiX } from 'react-icons/fi';
import { IconButton } from './IconButton';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  // What the panel is about — read out as its name.
  title: string;
  // Under the title: one line of context.
  description?: ReactNode;
  // Beside the close button: the panel's own actions.
  actions?: ReactNode;
  // Below the title: the panel at a glance (a status row). Stays put on a wide screen; on a phone it scrolls
  // away with the content, so the content keeps the screen.
  header?: ReactNode;
  // The panel's tabs: always in reach — on a phone they stick to the top while everything else scrolls.
  tabs?: ReactNode;
  children: ReactNode;
  width?: number;
  // This panel is taking over from another one, or handing over to it. The surface stays where it is and
  // only what is on it changes: no slide, no fade, and the page behind does not lighten in between.
  handover?: boolean;
  // Changes when the panel turns to something else (another tab): its content starts from the top again.
  scrollKey?: string;
}

// The panel arrives quickly and lands softly; it leaves a little faster than it came. Tweens, not springs
// (see motionPresets.ts): a tween is done when it says it is, so the panel answers a click at once.
const ENTER: Transition = { duration: 0.3, ease: [0.16, 1, 0.3, 1] };
const LEAVE: Transition = { duration: 0.2, ease: [0.4, 0, 0.6, 1] };
const AT_ONCE: Transition = { duration: 0 };
// The exit, with room to spare.
const LEAVE_MS = 340;

interface Motion {
  handover: boolean;
  // The viewer asked for less motion: the panel fades, it does not travel.
  still: boolean;
}

// pointerEvents flips at once at each end of the fade, so a click never lands on a closing backdrop.
const BACKDROP: Variants = {
  hidden: ({ handover }: Motion) => ({ opacity: handover ? 1 : 0, pointerEvents: 'none' }),
  shown: ({ handover }: Motion) => ({
    opacity: 1,
    pointerEvents: 'auto',
    transition: handover ? AT_ONCE : { duration: 0.24, ease: 'easeOut' },
  }),
  gone: ({ handover }: Motion) => ({
    opacity: 0,
    pointerEvents: 'none',
    transition: handover ? AT_ONCE : { duration: 0.2, ease: [0.4, 0, 0.6, 1] },
  }),
};

// The panel only travels. It is drawn inside the backdrop, so the backdrop's fade carries it — the two fade as
// one picture. (Fading the panel on its own as well let the dark backdrop show through it for a moment: a
// closing panel made the screen darker before it cleared, most of all on a phone.)
const PANEL: Variants = {
  hidden: ({ handover, still }: Motion) => ({ x: handover || still ? 0 : 56 }),
  shown: ({ handover }: Motion) => ({ x: 0, transition: handover ? AT_ONCE : ENTER }),
  gone: ({ handover, still }: Motion) => ({ x: handover || still ? 0 : 40, transition: handover ? AT_ONCE : LEAVE }),
};

// A panel that slides in from the right and keeps the page behind it in view —
// for looking into one row of a list without leaving the list. Same manners as
// Modal: Escape and a click outside close it, and the page behind does not
// scroll while it is open. On a phone it takes the whole screen.
export function Drawer({
  open,
  onClose,
  title,
  description,
  actions,
  header,
  tabs,
  children,
  width,
  handover = false,
  scrollKey,
}: DrawerProps) {
  const still = useReducedMotion() ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Another tab: its content is read from the top. On a wide screen that is the body's own scroll; on a
  // phone everything under the name scrolls as one, so it goes back only as far as the tabs — they stay
  // at the top, and what is above them is not pulled back into view.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    const above = head.current?.offsetHeight ?? 0;
    if (scroller.current && scroller.current.scrollTop > above) scroller.current.scrollTop = above;
  }, [scrollKey]);

  // AnimatePresence takes the panel out once everything inside has finished leaving — and a tab underline
  // that has moved (a shared-layout animation) can keep it waiting for ever: the closed panel stayed in the
  // page, invisible. So once the exit has had its time, the panel is taken out regardless — and at once
  // when it is handing over to another panel, which is already standing in its place.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (handover) {
      setPresent(false);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [open, handover]);
  if (!open && !present) return null;

  const how: Motion = { handover, still };
  return createPortal(
    // `custom` reaches a panel that is already leaving: how it goes is decided when it goes.
    <AnimatePresence custom={how}>
      {open && (
        <motion.div
          className={styles.backdrop}
          custom={how}
          variants={BACKDROP}
          initial="hidden"
          animate="shown"
          exit="gone"
          onClick={onClose}
        >
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="drawer-title"
            className={styles.drawer}
            style={width ? ({ '--drawer-width': `${width}px` } as React.CSSProperties) : undefined}
            custom={how}
            variants={PANEL}
            initial="hidden"
            animate="shown"
            exit="gone"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.headRow}>
              <div className={styles.heading}>
                <h2 id="drawer-title" className={styles.title}>
                  {title}
                </h2>
                {description && <div className={styles.description}>{description}</div>}
              </div>
              <div className={styles.headActions}>
                {actions}
                <IconButton icon={<FiX />} label="Close" onClick={onClose} />
              </div>
            </div>
            <div className={styles.scroller} ref={scroller}>
              {header && (
                <div className={styles.header} ref={head}>
                  {header}
                </div>
              )}
              <div className={styles.tabs}>{tabs}</div>
              <div className={styles.body} ref={body}>
                {children}
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
