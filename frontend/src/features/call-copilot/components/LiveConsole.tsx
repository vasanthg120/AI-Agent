import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiActivity, FiAlertCircle, FiFileText, FiGlobe, FiSquare, FiUser } from 'react-icons/fi';
import { Button, Skeleton } from '@/components/ui';
import type { CallEvent, CallRecommendation } from '@/services/callCopilotService';
import { FADE_UP, staggerChildren } from '../motion';
import { CustomerContextCard } from './CustomerContextCard';
import { CustomerSnapshotCard } from './CustomerSnapshotCard';
import { EventsFeed } from './EventsFeed';
import { VoiceOrb, type VoiceOrbState } from '@/components/voice/VoiceOrb';
import { VoiceWaveform } from '@/components/voice/VoiceWaveform';
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
  // The linked deal: its customer is summed up at the top of the customer panel.
  dealId?: string;
  languageLabel: string;
  stream: MediaStream | null;
  onEnd: () => void;
}

const ORB_LABEL: Record<VoiceOrbState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Analysing',
  speaking: 'Speaking',
};

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
  dealId,
  languageLabel,
  stream,
  onEnd,
}: LiveConsoleProps) {
  const wordCount = useMemo(() => (transcript.trim() ? transcript.trim().split(/\s+/).length : 0), [transcript]);

  // Haive's state on the bar: listening to the call — and thinking from the moment new speech
  // arrives until its suggestions and signals for it come back (or a while passes).
  const [analysing, setAnalysing] = useState(false);
  const firstTranscript = useRef(true);
  useEffect(() => {
    if (firstTranscript.current) {
      firstTranscript.current = false;
      return;
    }
    if (status !== 'recording' || !transcript) return;
    setAnalysing(true);
    const done = setTimeout(() => setAnalysing(false), 12_000);
    return () => clearTimeout(done);
  }, [transcript, status]);
  useEffect(() => setAnalysing(false), [recommendations, events, sentiment]);
  const orbState: VoiceOrbState = status !== 'recording' || analysing ? 'thinking' : 'listening';
  const orbLabel = status === 'starting' ? 'Connecting' : status === 'ending' ? 'Wrapping up' : ORB_LABEL[orbState];

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
          <span className={styles.voice}>
            <VoiceOrb state={orbState} stream={stream} size={34} tone="dark" showLabel label={orbLabel} />
            {/* The microphone from the moment it's on (it's recording while the call connects, too). */}
            <VoiceWaveform stream={status === 'ending' ? null : stream} tone="onDark" bars={22} />
          </span>
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
            {dealId && <CustomerSnapshotCard dealId={dealId} />}
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
