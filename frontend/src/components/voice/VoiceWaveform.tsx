import { useRef } from 'react';
import clsx from 'clsx';
import { useAudioFrames } from './useAudioFrames';
import styles from './VoiceWaveform.module.css';

export interface VoiceWaveformProps {
  // The sound to follow: a microphone, or an AI voice (streamOfElement). None: a calm idle wave.
  stream: MediaStream | null;
  // Animate as speaking even without a stream to measure (a browser that can't capture the voice).
  active?: boolean;
  bars?: number;
  tone?: 'accent' | 'onDark' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

// A voice-reactive waveform: bars mirrored from the centre, each following its own band of
// the voice and easing towards it, so it moves like speech rather than flickering. Drawn
// through refs on every frame (no React renders); a calm wave when there's nothing to hear.
export function VoiceWaveform({ stream, active = false, bars = 24, tone = 'accent', size = 'md', className }: VoiceWaveformProps) {
  const refs = useRef<Array<HTMLSpanElement | null>>([]);
  const heights = useRef<number[]>([]);

  useAudioFrames(
    stream,
    (level, bins) => {
      const half = Math.ceil(bars / 2);
      for (let i = 0; i < bars; i += 1) {
        // Mirrored: the centre bars take the strongest (lowest) speech bands.
        const distance = Math.abs(i - (bars - 1) / 2) / half;
        const bin = Math.min(bins.length - 1, 2 + Math.floor(distance * 34));
        const target = Math.min(1, 0.1 + (bins[bin] / 255) * 0.75 + level * 0.45 * (1 - distance * 0.6));
        const previous = heights.current[i] ?? 0.1;
        // Rise quickly, fall gently.
        const next = previous + (target - previous) * (target > previous ? 0.55 : 0.18);
        heights.current[i] = next;
        const bar = refs.current[i];
        if (bar) bar.style.transform = `scaleY(${next.toFixed(3)})`;
      }
    },
    () => {
      heights.current = [];
      refs.current.forEach((bar) => {
        if (bar) bar.style.transform = '';
      });
    },
  );

  const live = !!stream;
  return (
    <span
      className={clsx(styles.wave, styles[tone], styles[size], className)}
      data-live={live ? 'true' : 'false'}
      data-active={!live && active ? 'true' : 'false'}
      aria-hidden
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(node) => {
            refs.current[i] = node;
          }}
          className={styles.bar}
          style={{ '--i': i, '--d': Math.abs(i - (bars - 1) / 2) } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
