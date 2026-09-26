import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { FiInbox } from 'react-icons/fi';
import clsx from 'clsx';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: IconType;
  title: string;
  /** What will show up here, or what to do next. */
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

// The one "nothing here yet" treatment — tells the user what would appear
// here and what to do about it, instead of a bare line of grey text.
export function EmptyState({ icon: Icon = FiInbox, title, description, action, compact }: EmptyStateProps) {
  return (
    <div className={clsx(styles.empty, compact && styles.compact)}>
      <span className={styles.icon}>
        <Icon />
      </span>
      <span className={styles.title}>{title}</span>
      {description && <span className={styles.description}>{description}</span>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
