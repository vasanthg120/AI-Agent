import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiArrowDown } from 'react-icons/fi';
import { SPRING_SNAPPY } from '../motion';
import styles from './TranscriptPanel.module.css';

// How long text that just arrived stays highlighted before settling into the
// rest of the transcript.
const FRESH_MS = 2600;
// Scroll events fired by our own smooth-scroll are not the user reading back.
const FOLLOW_GRACE_MS = 700;
const BOTTOM_TOLERANCE_PX = 32;

// The live transcript. It follows the newest words while you listen, but the
// moment you scroll up to re-read something it stops following and offers a
// "Latest" button instead — a feed that yanks you back down every seven
// seconds is unreadable. New text lights up briefly so your eye finds it.
export function TranscriptPanel({ transcript, isRecording }: { transcript: string; isRecording: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const followUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const [settledLength, setSettledLength] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setSettledLength(transcript.length), FRESH_MS);
    return () => clearTimeout(timer);
  }, [transcript]);

  const scrollToLatest = (behavior: ScrollBehavior) => {
    const el = scroller.current;
    if (!el) return;
    followUntil.current = Date.now() + FOLLOW_GRACE_MS;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    if (following) scrollToLatest('smooth');
  }, [transcript, following]);

  const handleScroll = () => {
    const el = scroller.current;
    if (!el || Date.now() < followUntil.current) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOLERANCE_PX);
  };

  const settled = Math.min(settledLength, transcript.length);
  const older = transcript.slice(0, settled);
  const fresh = transcript.slice(settled);

  return (
    <div className={styles.wrapper}>
      <div ref={scroller} className={styles.scroller} onScroll={handleScroll} tabIndex={0} aria-label="Live transcript">
        {transcript ? (
          <p className={styles.text}>
            {older}
            {fresh && <span className={styles.fresh}>{fresh}</span>}
            {isRecording && <span className={styles.caret} aria-hidden />}
          </p>
        ) : (
          <div className={styles.empty}>
            <span className={styles.listening} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <p>{isRecording ? 'Listening… the transcript appears here every few seconds.' : 'The transcript will appear here once the call starts.'}</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {!following && transcript && (
          <motion.button
            type="button"
            className={styles.jump}
            initial={{ opacity: 0, y: 8, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.94 }}
            transition={SPRING_SNAPPY}
            onClick={() => {
              setFollowing(true);
              scrollToLatest('smooth');
            }}
          >
            <FiArrowDown aria-hidden /> Latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
