import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiCheck,
  FiChevronDown,
  FiCopy,
  FiCornerUpRight,
  FiHelpCircle,
  FiMessageCircle,
  FiShield,
  FiZap,
} from 'react-icons/fi';
import type { CallRecommendation } from '@/services/callCopilotService';
import { EASE_OUT, ROW_IN, SPRING_SOFT } from '../motion';
import styles from './RecommendationsPanel.module.css';

type Tone = 'accent' | 'info' | 'danger' | 'success';

const TYPE_META: Record<
  CallRecommendation['type'],
  { label: string; hint: string; icon: typeof FiMessageCircle; tone: Tone }
> = {
  say: { label: 'Say this', hint: 'Something worth saying now', icon: FiMessageCircle, tone: 'accent' },
  ask: { label: 'Ask this', hint: 'A question worth asking', icon: FiHelpCircle, tone: 'info' },
  handle_objection: {
    label: 'Handle the objection',
    hint: 'How to respond to pushback',
    icon: FiShield,
    tone: 'danger',
  },
  next_action: { label: 'Next step', hint: 'What to do to move it forward', icon: FiCornerUpRight, tone: 'success' },
};

const NEW_BADGE_MS = 9000;
const EARLIER_LIMIT = 7;

// The one thing to glance at mid-call: the newest suggestion, big, with the
// earlier ones tucked underneath. A suggestion you've already scrolled past is
// still one click away, but it never competes with the current one.
export function RecommendationsPanel({ recommendations }: { recommendations: CallRecommendation[] }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [isFresh, setIsFresh] = useState(false);
  const [copied, setCopied] = useState(false);
  // -1 until the first render has recorded what was already there.
  const seenCount = useRef(-1);

  const latest = recommendations[recommendations.length - 1];
  const earlier = recommendations.slice(0, -1).reverse().slice(0, EARLIER_LIMIT);

  // "New" only for a suggestion that arrived while you were looking, not one already there on mount.
  useEffect(() => {
    const arrivedNow = seenCount.current >= 0 && recommendations.length > seenCount.current;
    seenCount.current = recommendations.length;
    if (!arrivedNow) return;
    setIsFresh(true);
    const timer = setTimeout(() => setIsFresh(false), NEW_BADGE_MS);
    return () => clearTimeout(timer);
  }, [recommendations.length]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure context) — the text is on screen to read.
    }
  };

  if (!latest) {
    return (
      <div className={styles.waiting}>
        <span className={styles.waitingIcon} aria-hidden>
          <FiZap />
        </span>
        <div className={styles.waitingText}>
          <strong>Your next move shows up here</strong>
          <span>As the conversation unfolds, HaiVE suggests what to say, what to ask and how to handle pushback.</span>
        </div>
        <ul className={styles.legend} aria-label="Kinds of suggestion">
          {Object.values(TYPE_META).map((meta) => (
            <li key={meta.label} className={clsx(styles.legendItem, styles[meta.tone])}>
              <meta.icon aria-hidden /> {meta.label}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const meta = TYPE_META[latest.type];
  const Icon = meta.icon;

  return (
    <div className={styles.wrapper}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.article
          key={`${recommendations.length}-${latest.text}`}
          className={clsx(styles.hero, styles[meta.tone])}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.34, ease: EASE_OUT }}
        >
          <span className={styles.heroIcon} aria-hidden>
            <Icon />
          </span>
          <div className={styles.heroBody}>
            <div className={styles.eyebrow}>
              <span>Suggested next move</span>
              <span className={styles.dotSep} aria-hidden />
              <span className={styles.kind}>{meta.label}</span>
              {isFresh && <span className={styles.newTag}>New</span>}
            </div>
            <p className={styles.heroText}>{latest.text}</p>
          </div>
          <button
            type="button"
            className={styles.copy}
            onClick={() => void copy(latest.text)}
            aria-label={copied ? 'Copied' : 'Copy suggestion'}
            title={copied ? 'Copied' : 'Copy suggestion'}
          >
            {copied ? <FiCheck /> : <FiCopy />}
          </button>
        </motion.article>
      </AnimatePresence>

      {earlier.length > 0 && (
        <div className={styles.earlier}>
          <button
            type="button"
            className={styles.earlierToggle}
            aria-expanded={showEarlier}
            onClick={() => setShowEarlier((open) => !open)}
          >
            Earlier suggestions <span className={styles.count}>{earlier.length}</span>
            <FiChevronDown className={clsx(styles.chevron, showEarlier && styles.chevronOpen)} aria-hidden />
          </button>
          <AnimatePresence initial={false}>
            {showEarlier && (
              <motion.ul
                className={styles.list}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={SPRING_SOFT}
              >
                {earlier.map((rec, index) => {
                  const earlierMeta = TYPE_META[rec.type];
                  const EarlierIcon = earlierMeta.icon;
                  return (
                    <motion.li
                      key={`${rec.text}-${index}`}
                      className={clsx(styles.row, styles[earlierMeta.tone])}
                      variants={ROW_IN}
                      initial="hidden"
                      animate="show"
                    >
                      <span className={styles.rowIcon} aria-hidden>
                        <EarlierIcon />
                      </span>
                      <div>
                        <div className={styles.rowKind}>{earlierMeta.label}</div>
                        <div className={styles.rowText}>{rec.text}</div>
                      </div>
                    </motion.li>
                  );
                })}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
