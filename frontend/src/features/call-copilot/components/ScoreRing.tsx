import { useEffect } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import clsx from 'clsx';
import { EASE_OUT } from '../motion';
import styles from './ScoreRing.module.css';

export type ScoreTone = 'success' | 'warning' | 'danger' | 'muted';

// The same three bands everywhere a score appears (debrief, library rows), so
// "green" always means the same thing.
export function scoreTone(score: number): Exclude<ScoreTone, 'muted'> {
  if (score >= 7) return 'success';
  if (score >= 4) return 'warning';
  return 'danger';
}

export function scoreBand(score: number): string {
  if (score >= 8.5) return 'Excellent';
  if (score >= 7) return 'Strong';
  if (score >= 4) return 'Fair';
  return 'Needs work';
}

export interface ScoreRingProps {
  value: number;
  size?: number;
  strokeWidth?: number;
  // Greyed out — a score that says "nothing to score" rather than "scored badly".
  muted?: boolean;
  showOutOf?: boolean;
  className?: string;
}

// A ring that fills — and counts up — to the score when it appears. One motion
// value drives both the arc and the number, so they can never disagree.
export function ScoreRing({ value, size = 132, strokeWidth = 10, muted, showOutOf = true, className }: ScoreRingProps) {
  const clamped = Math.min(10, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const wholeNumber = Number.isInteger(clamped);

  const progress = useMotionValue(0);
  const arc = useTransform(progress, (p) => p / 10);
  const label = useTransform(progress, (p) => (wholeNumber ? String(Math.round(p)) : p.toFixed(1)));

  useEffect(() => {
    const controls = animate(progress, clamped, { duration: 1.1, ease: EASE_OUT });
    return () => controls.stop();
  }, [clamped, progress]);

  const tone: ScoreTone = muted ? 'muted' : scoreTone(clamped);

  return (
    <div
      className={clsx(styles.ring, styles[tone], className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Score ${clamped} out of 10`}
    >
      <svg className={styles.svg} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className={styles.track} cx={center} cy={center} r={radius} strokeWidth={strokeWidth} fill="none" />
        {clamped > 0 && (
          <motion.circle
            className={styles.arc}
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={strokeWidth}
            fill="none"
            strokeLinecap="round"
            pathLength={arc}
          />
        )}
      </svg>
      <div className={styles.center}>
        <motion.span className={styles.value} style={{ fontSize: size * 0.3 }}>
          {label}
        </motion.span>
        {showOutOf && <span className={styles.outOf}>out of 10</span>}
      </div>
    </div>
  );
}
