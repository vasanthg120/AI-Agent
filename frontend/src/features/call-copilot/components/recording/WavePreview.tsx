import { useMemo } from 'react';
import clsx from 'clsx';
import styles from './WavePreview.module.css';

// A recording's shape, drawn small (the file being uploaded): bars that rise in one after
// another, coloured up to `progress` (0–1). Waiting for the shape: a calm shimmer.
export function WavePreview({ peaks, progress = 1, bars = 64, className }: { peaks: number[] | null; progress?: number; bars?: number; className?: string }) {
  const heights = useMemo(() => {
    if (!peaks?.length) return null;
    return Array.from({ length: bars }, (_, i) => {
      const from = Math.floor((i / bars) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let max = 0;
      for (let p = from; p < to; p += 1) max = Math.max(max, peaks[p] ?? 0);
      return Math.max(0.08, max);
    });
  }, [peaks, bars]);

  return (
    <span
      className={clsx(styles.preview, !heights && styles.pending, className)}
      style={{ '--progress': Math.min(1, Math.max(0, progress)) } as React.CSSProperties}
      aria-hidden
    >
      {[false, true].map((filled) => (
        <span key={String(filled)} className={clsx(styles.layer, filled && styles.filled)}>
          {(heights ?? Array.from({ length: bars }, (_, i) => 0.25 + 0.15 * Math.sin(i / 3))).map((h, i) => (
            <span key={i} className={styles.bar} style={{ height: `${Math.round(h * 100)}%`, '--i': i } as React.CSSProperties} />
          ))}
        </span>
      ))}
    </span>
  );
}
