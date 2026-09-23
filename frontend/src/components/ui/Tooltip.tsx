import { useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { TOOLTIP_SPRING } from './motionPresets';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: string;
  children: ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className={styles.wrapper}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      <AnimatePresence>
        {visible && (
          <motion.span
            role="tooltip"
            className={clsx(styles.bubble, styles[placement])}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={TOOLTIP_SPRING}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
