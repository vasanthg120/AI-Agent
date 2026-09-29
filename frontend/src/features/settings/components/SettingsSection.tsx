import type { ReactNode } from 'react';
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
    // A plain section: the page's own entrance animation fades it in. It used to
    // start invisible and wait for an IntersectionObserver, so every tab switch
    // or reload of a section blinked before its content showed.
    <section className={styles.section}>
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
    </section>
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
