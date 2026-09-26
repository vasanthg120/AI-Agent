import { useEffect } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { EASE_OUT } from '../motion';

// A number that rolls up to its value on first paint and rolls to the new one
// when it changes — used for the Call Library's headline figures.
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const current = useMotionValue(0);
  const text = useTransform(current, (v) => v.toFixed(decimals));

  useEffect(() => {
    const controls = animate(current, value, { duration: 0.9, ease: EASE_OUT });
    return () => controls.stop();
  }, [value, current]);

  return <motion.span>{text}</motion.span>;
}
