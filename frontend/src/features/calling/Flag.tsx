import clsx from 'clsx';
import { flagOf } from '@/services/callingService';
import styles from './Flag.module.css';

// A country marker that works everywhere: the flag emoji where the platform
// draws flags, a small country-code badge where it doesn't (Windows).
export function Flag({ iso, size = 'md', className }: { iso: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const emoji = flagOf(iso);
  return emoji ? (
    <span className={clsx(styles.emoji, styles[size], className)} aria-hidden>
      {emoji}
    </span>
  ) : (
    <span className={clsx(styles.badge, styles[`badge_${size}`], className)} aria-hidden>
      {iso.toUpperCase()}
    </span>
  );
}
