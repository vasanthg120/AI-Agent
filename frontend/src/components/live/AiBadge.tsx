import clsx from 'clsx';
import { FiZap } from 'react-icons/fi';
import styles from './AiBadge.module.css';

export interface AiBadgeProps {
  /** Default "AI". */
  label?: string;
  /** What the AI wrote, for the tooltip. */
  title?: string;
  className?: string;
}

/**
 * Marks what the AI wrote or worked out (a summary, a type, a draft, a recommendation),
 * so it is never mistaken for the source's own data — which the Live indicator marks.
 */
export function AiBadge({ label = 'AI', title = 'Written by the AI from the stored records — not taken from the source', className }: AiBadgeProps) {
  return (
    <span className={clsx(styles.badge, className)} title={title}>
      <FiZap size={10} aria-hidden />
      {label}
    </span>
  );
}
