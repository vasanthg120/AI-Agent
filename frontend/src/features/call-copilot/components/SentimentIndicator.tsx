import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiFrown, FiMeh, FiSmile } from 'react-icons/fi';
import { SPRING_SNAPPY } from '../motion';
import styles from './SentimentIndicator.module.css';

type Tone = 'success' | 'neutral' | 'danger' | 'warning';

export const SENTIMENT_META: Record<string, { icon: typeof FiSmile; label: string; tone: Tone }> = {
  positive: { icon: FiSmile, label: 'Positive', tone: 'success' },
  neutral: { icon: FiMeh, label: 'Neutral', tone: 'neutral' },
  negative: { icon: FiFrown, label: 'Negative', tone: 'danger' },
  mixed: { icon: FiMeh, label: 'Mixed', tone: 'warning' },
};

// How the customer is coming across right now. When it changes the old reading
// slides out and the new one in, so a shift in mood is noticed, not just re-rendered.
export function SentimentIndicator({ sentiment, onDark }: { sentiment: string | null; onDark?: boolean }) {
  const meta = sentiment ? SENTIMENT_META[sentiment] : undefined;
  const Icon = meta?.icon;

  return (
    <span
      className={clsx(styles.pill, styles[meta?.tone ?? 'none'], onDark && styles.onDark)}
      title="Customer sentiment"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={sentiment ?? 'none'}
          className={styles.inner}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={SPRING_SNAPPY}
        >
          {Icon ? <Icon aria-hidden /> : <span className={styles.pending} aria-hidden />}
          {meta ? meta.label : 'Reading the mood…'}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
