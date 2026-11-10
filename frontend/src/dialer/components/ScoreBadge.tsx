import { scoreTone } from '../lib/callText';
import styles from './ScoreBadge.module.css';

/** A call's AI score (out of 10) as a small coloured pill. */
export function ScoreBadge({ score }: { score: number }) {
  return (
    <span className={`${styles.badge} ${styles[scoreTone(score)]}`} aria-label={`Score ${score.toFixed(1)} out of 10`}>
      {score.toFixed(1)}
    </span>
  );
}
