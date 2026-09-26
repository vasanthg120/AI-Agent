import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import styles from './SettingsSection.module.css';

export interface SettingsSectionProps {
  title: string;
  description?: string;
  /** Optional icon shown in a tile beside the title. */
  icon?: ReactNode;
  /** Optional element aligned to the right of the header (a badge, a toggle, a small action). */
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function SettingsSection({ title, description, icon, actions, children, footer }: SettingsSectionProps) {
  return (
    // Fades up the first time it scrolls into view, so long tabs reveal
    // section by section instead of popping in all at once.
    <motion.section
      className={styles.section}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -40px 0px' }}
      transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.header}>
        {icon && <span className={styles.headerIcon}>{icon}</span>}
        <div className={styles.headerText}>
          <h2 className={styles.title}>{title}</h2>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </motion.section>
  );
}

export function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </div>
  );
}
