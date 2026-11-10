import { useId } from 'react';
import type { ReactNode } from 'react';
import styles from './StateScreen.module.css';

/** A whole-screen message: what is going on, in plain words, and what can be done about it. */
export function StateScreen({
  icon,
  title,
  children,
  actions,
  tone = 'neutral',
  level = 1,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger';
  // 2 when shown inside a screen that already has its own heading.
  level?: 1 | 2;
}) {
  const titleId = useId();
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section className={styles.screen} aria-labelledby={titleId}>
      <span className={`${styles.icon} ${styles[tone]}`} aria-hidden>
        {icon}
      </span>
      <Heading id={titleId} className={styles.title}>
        {title}
      </Heading>
      {children && <div className={styles.text}>{children}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </section>
  );
}

/** The big, thumb-friendly button these screens use. */
export function ActionButton({
  children,
  onClick,
  href,
  variant = 'primary',
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  busy?: boolean;
}) {
  const className = `${styles.button} ${styles[variant]}`;
  if (href) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}
