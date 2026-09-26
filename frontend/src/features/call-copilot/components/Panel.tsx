import type { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Panel.module.css';

export interface PanelProps {
  title: string;
  icon?: ReactNode;
  // Small muted text on the right of the header ("128 words", "3 detected").
  meta?: ReactNode;
  // Something clickable on the right of the header.
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  // Drop the body padding — for content that runs edge to edge (a scroller).
  flush?: boolean;
}

// The one card every Call Copilot section sits in, so the transcript, signals,
// context and coach all share the same header rhythm.
export function Panel({ title, icon, meta, action, children, className, flush }: PanelProps) {
  return (
    <section className={clsx(styles.panel, className)}>
      <header className={styles.header}>
        <h3 className={styles.title}>
          {icon && (
            <span className={styles.icon} aria-hidden>
              {icon}
            </span>
          )}
          {title}
        </h3>
        <div className={styles.headerEnd}>
          {meta && <span className={styles.meta}>{meta}</span>}
          {action}
        </div>
      </header>
      <div className={clsx(styles.body, flush && styles.flush)}>{children}</div>
    </section>
  );
}
