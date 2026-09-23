import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiInfo } from 'react-icons/fi';
import { useClickOutside } from '@/hooks/useClickOutside';
import { POPUP_SPRING } from './motionPresets';
import styles from './InfoPopover.module.css';

export interface InfoPopoverProps {
  title: string;
  children: ReactNode;
  align?: 'left' | 'right';
  placement?: 'top' | 'bottom';
  // Additive — most triggers are the small (i) badge, but a handful of
  // headers (e.g. the per-tab explainer next to the Tabs bar) want a
  // labeled "What is this?" button instead of a bare icon.
  label?: string;
}

// Click-to-open, stays-open explanation popup — distinct from Tooltip
// (hover-only, one-line, pointer-events:none) because every call site here
// needs several sentences (what a card/table/chart shows, how it's
// calculated, where the numbers come from), which a hover bubble can't hold
// long enough to read. Same click-outside/positioning convention as
// Dropdown, scoped down to a text panel instead of a menu list.
export function InfoPopover({ title, children, align = 'left', placement = 'bottom', label }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useClickOutside(wrapperRef, () => setOpen(false), open);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={clsx(styles.trigger, label && styles.triggerLabeled)}
        aria-label={label ? undefined : `Explain: ${title}`}
        aria-expanded={open}
        onClick={(event) => {
          // Several call sites nest this inside a card/row that has its own
          // onClick (e.g. a drill-down or a "click to open the full email"
          // handler) — without this, opening the explanation would also
          // trigger that outer action.
          event.stopPropagation();
          setOpen((p) => !p);
        }}
      >
        <FiInfo size={label ? 13 : 12} />
        {label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={title}
            className={clsx(styles.panel, styles[align], styles[placement])}
            initial={{ opacity: 0, y: placement === 'bottom' ? -6 : 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: placement === 'bottom' ? -4 : 4, scale: 0.97 }}
            transition={POPUP_SPRING}
          >
            <div className={styles.panelTitle}>{title}</div>
            <div className={styles.panelBody}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
