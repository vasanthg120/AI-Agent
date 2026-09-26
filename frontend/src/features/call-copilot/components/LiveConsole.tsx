import { useMemo } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiActivity, FiAlertCircle, FiFileText, FiGlobe, FiSquare, FiUser } from 'react-icons/fi';
import { Button, Skeleton } from '@/components/ui';
import type { CallEvent, CallRecommendation } from '@/services/callCopilotService';
import { FADE_UP, staggerChildren } from '../motion';
import { CustomerContextCard } from './CustomerContextCard';
import { EventsFeed } from './EventsFeed';
import { LevelMeter } from './LevelMeter';
import { Panel } from './Panel';
import { RecommendationsPanel } from './RecommendationsPanel';
import { SentimentIndicator } from './SentimentIndicator';
import { TranscriptPanel } from './TranscriptPanel';
import styles from './LiveConsole.module.css';

export type LiveStatus = 'starting' | 'recording' | 'ending';

export interface LiveConsoleProps {
  status: LiveStatus;
  elapsedSeconds: number;
  transcript: string;
  events: CallEvent[];
  recommendations: CallRecommendation[];
  sentiment: string | null;
  contextBlob: string;
  warning: string | null;
  customerLabel?: string;
  languageLabel: string;
  stream: MediaStream | null;
  onEnd: () => void;
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  starting: 'Connecting',
  recording: 'Live',
  ending: 'Wrapping up',
};

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// The screen you work from during a call. Everything on it answers "what's
// happening and what should I do next": the status bar says the call is being
// captured (and that the mic is hearing you), the big card says what to do now,
// and the transcript, signals and customer context sit around it for reference.
export function LiveConsole({
  status,
  elapsedSeconds,
  transcript,
  events,
  recommendations,
  sentiment,
  contextBlob,
  warning,
  customerLabel,
  languageLabel,
  stream,
  onEnd,
}: LiveConsoleProps) {
  const wordCount = useMemo(() => (transcript.trim() ? transcript.trim().split(/\s+/).length : 0), [transcript]);

  return (
    <motion.div className={styles.console} variants={staggerChildren(0.08)} initial="hidden" animate="show">
      <motion.header variants={FADE_UP} className={styles.bar}>
        <div className={styles.barMain}>
          <span className={clsx(styles.badge, styles[status])} role="status" aria-live="polite">
            <i className={styles.pulse} aria-hidden />
            {STATUS_LABEL[status]}
          </span>
          <span className={styles.timer} aria-label="Call duration">
            {formatClock(elapsedSeconds)}
          </span>
          <LevelMeter stream={status === 'recording' ? stream : null} />
        </div>

        <div className={styles.barMeta}>
          {customerLabel && (
            <span className={styles.chip} title="Linked deal">
              <FiUser aria-hidden /> {customerLabel}
            </span>
          )}
          <span className={styles.chip} title="Spoken language">
            <FiGlobe aria-hidden /> {languageLabel}
          </span>
          <SentimentIndicator sentiment={sentiment} onDark />
        </div>

        <Button
          type="button"
          variant="danger"
          className={styles.endButton}
          leftIcon={<FiSquare />}
          onClick={onEnd}
          disabled={status === 'ending'}
          loading={status === 'ending'}
        >
          End call
        </Button>
      </motion.header>

      {warning && (
        <motion.div variants={FADE_UP} className={styles.warning} role="status">
          <FiAlertCircle aria-hidden /> {warning}
        </motion.div>
      )}

      <div className={styles.grid}>
        <motion.div variants={FADE_UP} className={styles.column}>
          <RecommendationsPanel recommendations={recommendations} />
          <Panel
            title="Live transcript"
            icon={<FiFileText />}
            meta={wordCount > 0 ? `${wordCount.toLocaleString()} words` : undefined}
            flush
          >
            <TranscriptPanel transcript={transcript} isRecording={status === 'recording'} />
          </Panel>
        </motion.div>

        <motion.aside variants={FADE_UP} className={styles.column} aria-label="Call details">
          <Panel
            title="Signals"
            icon={<FiActivity />}
            meta={events.length > 0 ? `${events.length} detected` : undefined}
          >
            <EventsFeed events={events} />
          </Panel>
          <Panel title="Customer context" icon={<FiUser />}>
            {contextBlob === '' && status === 'starting' ? (
              <div className={styles.skeletons}>
                <Skeleton height={54} />
                <Skeleton height={54} />
              </div>
            ) : (
              <CustomerContextCard contextBlob={contextBlob} />
            )}
          </Panel>
        </motion.aside>
      </div>
    </motion.div>
  );
}
