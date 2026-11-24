import { useRef } from 'react';
import clsx from 'clsx';
import { useAudioFrames } from './useAudioFrames';
import styles from './VoiceOrb.module.css';

export type VoiceOrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceOrbProps {
  state: VoiceOrbState;
  // What it reacts to: the microphone while listening, the AI's voice while speaking.
  stream?: MediaStream | null;
  size?: number;
  // Said to screen readers (and shown when showLabel).
  label?: string;
  showLabel?: boolean;
  tone?: 'light' | 'dark';
  className?: string;
}

const STATE_TEXT: Record<VoiceOrbState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

// Haive's animated avatar. Idle: it breathes. Listening: a halo swells with the voice it
// hears. Thinking: an arc circles it. Speaking: ripples spread out in time with its own
// voice. The loudness drives a CSS variable through a ref — no React render per frame.
export function VoiceOrb({ state, stream = null, size = 44, label, showLabel = false, tone = 'light', className }: VoiceOrbProps) {
  const root = useRef<HTMLSpanElement | null>(null);
  const smoothed = useRef(0);

  useAudioFrames(
    state === 'listening' || state === 'speaking' ? stream : null,
    (level) => {
      smoothed.current += (level - smoothed.current) * (level > smoothed.current ? 0.5 : 0.12);
      root.current?.style.setProperty('--level', smoothed.current.toFixed(3));
    },
    () => {
      smoothed.current = 0;
      root.current?.style.setProperty('--level', '0');
    },
  );

  const text = label ?? STATE_TEXT[state];
  return (
    <span className={clsx(styles.wrap, className)}>
      <span
        ref={root}
        className={clsx(styles.orb, styles[tone])}
        data-state={state}
        data-measured={stream && (state === 'listening' || state === 'speaking') ? 'true' : 'false'}
        style={{ '--size': `${size}px` } as React.CSSProperties}
        role="img"
        aria-label={`Haive: ${text}`}
      >
        <span className={styles.ripple} />
        <span className={clsx(styles.ripple, styles.rippleLate)} />
        <span className={styles.halo} />
        <span className={styles.arc} />
        <span className={styles.core}>
          <img src="/haive-logo.png" alt="" draggable={false} />
        </span>
      </span>
      {showLabel && (
        <span className={styles.label} aria-hidden>
          {text}
          {state === 'thinking' && <span className={styles.dots} />}
        </span>
      )}
    </span>
  );
}
