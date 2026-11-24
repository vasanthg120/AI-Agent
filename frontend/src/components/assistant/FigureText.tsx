import { useEffect, useRef } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import styles from './AssistantBriefing.module.css';

// Numbers in a sentence: "₹2,26,851", "9", "2.3", "56.7" (dates and years are left alone).
const NUMBER = /(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

function isYear(raw: string): boolean {
  const n = Number(raw);
  return /^\d{4}$/.test(raw) && n >= 1900 && n <= 2100;
}

/** A figure that counts up to itself, written the way it was (2,26,851 stays Indian-grouped). */
function CountFigure({ raw, run }: { raw: string; run: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    const target = Number(raw.replace(/,/g, ''));
    if (!el || reduce || !Number.isFinite(target) || target === 0) return;
    const decimals = raw.split('.')[1]?.length ?? 0;
    const grouped = raw.includes(',');
    const locale = /\d,\d{2},\d{3}/.test(raw) ? 'en-IN' : 'en-US';
    const format = (v: number) =>
      grouped ? v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals);
    const controls = animate(0, target, {
      duration: 1.1,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = format(v);
      },
      onComplete: () => {
        el.textContent = raw;
      },
    });
    return () => {
      controls.stop();
      el.textContent = raw;
    };
  }, [raw, run, reduce]);
  return (
    <span ref={ref} className={styles.figure}>
      {raw}
    </span>
  );
}

/** Text whose figures count up — when it first shows, and again each time `run` changes. */
export function FigureText({ text, run = 0 }: { text: string; run?: number }) {
  const parts = text.split(NUMBER);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 && !isYear(part) ? <CountFigure key={i} raw={part} run={run} /> : part))}
    </>
  );
}

const STOP = new Set(['that', 'this', 'with', 'have', 'from', 'your', 'their', 'there', 'about', 'which', 'were', 'been', 'will', 'into', 'than', 'they', 'them', 'what', 'just', 'some', 'more']);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[,₹$]/g, '')
      .split(/[^a-z0-9.]+/i)
      .filter((w) => (/\d/.test(w) ? w.length > 0 : w.length > 3 && !STOP.has(w))),
  );
}

/** Which of the points a spoken sentence is about (most words and figures in common), or -1. */
export function pointSpoken(points: string[], sentence: string | null): number {
  if (!sentence) return -1;
  const said = words(sentence);
  let best = -1;
  let bestScore = 1;
  points.forEach((point, i) => {
    let score = 0;
    for (const w of words(point)) if (said.has(w)) score += /\d/.test(w) ? 2 : 1;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
