import { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';

export interface AnimatedNumberProps {
  value: number;
  /** Formats each intermediate frame; defaults to a locale-grouped integer. */
  format?: (n: number) => string;
  duration?: number;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString();

// Counts from the previous value to the new one — on first mount from 0 —
// so a changed figure visibly moves instead of silently swapping.
export function AnimatedNumber({ value, format = defaultFormat, duration = 0.9 }: AnimatedNumberProps) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);

  useEffect(() => {
    if (reduce) {
      setDisplay(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(v),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);

  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(display)}</span>;
}
