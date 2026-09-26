import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { motion } from 'framer-motion';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  title: string;
  /** One plain-language sentence: what this page is for. */
  subtitle?: ReactNode;
  icon?: IconType;
  /** Buttons / controls aligned to the right of the title. */
  actions?: ReactNode;
  /** Small row under the title — status chips, a last-updated time, filters. */
  meta?: ReactNode;
}

const EASE = [0.16, 1, 0.3, 1] as const;

// The one page-title treatment for every top-level page, replacing each
// feature's own .pageTitle/.pageSubtitle pair so the app reads as one
// product: an icon tile, a title, a single sentence explaining the page,
// and a slot for the page's primary actions.
export function PageHeader({ title, subtitle, icon: Icon, actions, meta }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.main}>
        {Icon && (
          <motion.span
            className={styles.icon}
            initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 20, delay: 0.05 }}
          >
            <Icon />
          </motion.span>
        )}
        <div className={styles.text}>
          <motion.h1
            className={styles.title}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {title}
          </motion.h1>
          {subtitle && (
            <motion.p
              className={styles.subtitle}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.35, ease: EASE, delay: 0.06 }}
            >
              {subtitle}
            </motion.p>
          )}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>
      {actions && (
        <motion.div
          className={styles.actions}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: EASE, delay: 0.1 }}
        >
          {actions}
        </motion.div>
      )}
    </header>
  );
}
