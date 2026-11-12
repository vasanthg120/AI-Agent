import type { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Badge.module.css';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
  title?: string;
}

export function Badge({ children, variant = 'neutral', dot, className, title }: BadgeProps) {
  return (
    <span className={clsx(styles.badge, styles[variant], className)} title={title}>
      {dot && <span className={styles.dot} aria-hidden />}
      {children}
    </span>
  );
}
