import { useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertTriangle,
  FiArrowRight,
  FiAward,
  FiCheck,
  FiChevronDown,
  FiCompass,
  FiEye,
  FiMessageSquare,
  FiStar,
  FiTarget,
  FiTrendingUp,
  FiZap,
} from 'react-icons/fi';
import { Button } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import {
  callCopilotService,
  type CallKeyMoment,
  type CallScoreCategory,
  type CoachingReport,
} from '@/services/callCopilotService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { EASE_OUT, FADE_UP, ROW_IN, SPRING_SOFT, staggerChildren } from '../motion';
import { ScoreRing, scoreBand, scoreTone } from './ScoreRing';
import { VoiceCoachButton } from './VoiceCoachButton';
import styles from './AiCoachPanel.module.css';

const CATEGORY_LABEL: Record<CallScoreCategory, string> = {
  opening_rapport: 'Opening & Rapport',
  discovery_listening: 'Discovery & Listening',
  value_communication: 'Value Communication',
  objection_handling: 'Objection Handling',
  engagement_confidence: 'Engagement & Confidence',
  closing_followup: 'Closing & Follow-up',
};

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'accent';

const MOMENT_META: Record<CallKeyMoment['momentType'], { label: string; tone: Tone; icon: typeof FiStar }> = {
  great_moment: { label: 'Great moment', tone: 'success', icon: FiStar },
  missed_opportunity: { label: 'Missed opportunity', tone: 'warning', icon: FiCompass },
  buying_signal: { label: 'Buying signal', tone: 'info', icon: FiTrendingUp },
  risk_signal: { label: 'Risk signal', tone: 'danger', icon: FiAlertTriangle },
};

const BAND_TEXT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'A strong call — the notes below show what worked so you can repeat it.',
  warning: 'Some good moments, with clear room to grow. Start with the improvements below.',
  danger: 'Plenty to build on. The notes below show exactly where to start.',
};

const COACH_LANGUAGE_STORAGE_KEY = 'haive-ai-coach-voice-language';

// The coach's spoken language is its own remembered choice (not the language
// the call itself was transcribed in) — a sales rep may run a Tamil call but
// want the feedback in English, or the reverse. Defaults to English.
function readStoredCoachLanguage(): string {
  try {
    const stored = localStorage.getItem(COACH_LANGUAGE_STORAGE_KEY);
    if (stored && VOICE_LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    // localStorage can throw in a locked-down browser context — fall back silently.
  }
  return 'en';
}

function formatElapsed(occurredAt: string | undefined, createdAt: string | undefined): string | null {
  if (!occurredAt || !createdAt) return null;
  const seconds = Math.max(0, Math.round((new Date(occurredAt).getTime() - new Date(createdAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface AiCoachPanelProps {
  sessionId?: string;
  createdAt?: string;
  // True while we're actively expecting coaching to arrive shortly via
  // socket (a live call that just ended, or an upload that just finished) —
  // distinct from a historical call that simply never had one, which shows
  // the "Generate Coaching Report" button instead.
  pending?: boolean;
  coaching?: CoachingReport | null;
  onGenerated?: (report: CoachingReport) => void;
}

export function AiCoachPanel({ sessionId, createdAt, pending, coaching, onGenerated }: AiCoachPanelProps) {
  const [generating, setGenerating] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState(readStoredCoachLanguage);
  const [openCategory, setOpenCategory] = useState<CallScoreCategory | null>(null);

  const changeVoiceLanguage = (code: string) => {
    setVoiceLanguage(code);
    try {
      localStorage.setItem(COACH_LANGUAGE_STORAGE_KEY, code);
    } catch {
      // Non-fatal — the selection still works for this session.
    }
  };
  const hasCoaching = coaching?.overallScore !== undefined;

  const handleGenerate = async () => {
    if (!sessionId) return;
    setGenerating(true);
    try {
      const report = await callCopilotService.generateCoaching(sessionId);
      onGenerated?.(report);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  if (!hasCoaching) {
    if (pending || generating) {
      return (
        <div className={styles.pendingState} role="status" aria-live="polite">
          <span className={styles.pendingOrb} aria-hidden>
            <FiZap />
          </span>
          <div className={styles.pendingText}>
            <strong>Your AI Coach is reviewing this call…</strong>
            <span>
              This usually takes under a minute. You can close this window — the report will be waiting in Call Library.
            </span>
          </div>
          <div className={styles.pendingLines} aria-hidden>
            <i />
            <i />
            <i />
          </div>
        </div>
      );
    }
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon} aria-hidden>
          <FiAward />
        </span>
        <div className={styles.emptyText}>
          <strong>This call hasn&apos;t been coached yet</strong>
          <span>
            Your AI Coach reviews the conversation, scores it on six sales skills and tells you what to try next.
          </span>
        </div>
        <Button type="button" leftIcon={<FiZap />} disabled={!sessionId} onClick={() => void handleGenerate()}>
          Generate coaching report
        </Button>
      </div>
    );
  }

  const report = coaching!;
  const overall = report.overallScore ?? 0;
  // A call with no sales conversation (a tech test, a wrong number) has nothing to
  // score — every skill comes back 0. Say that, instead of presenting it as a failure.
  const notScored = report.categoryScores.length > 0 && report.categoryScores.every((c) => c.score === 0);
  const tone = scoreTone(overall);

  return (
    <motion.div className={styles.panel} variants={staggerChildren(0.08)} initial="hidden" animate="show">
      <motion.section variants={FADE_UP} className={styles.scoreCard}>
        <ScoreRing value={overall} muted={notScored} />
        <div className={styles.scoreText}>
          <span className={clsx(styles.band, notScored ? styles.bandMuted : styles[tone])}>
            {notScored ? 'Not scored' : scoreBand(overall)}
          </span>
          <h3 className={styles.scoreTitle}>Overall score for this call</h3>
          <p className={styles.scoreCopy}>
            {notScored ? 'There was no sales conversation to score in this call.' : BAND_TEXT[tone]}
          </p>
          {report.voiceScript && (
            <div className={styles.voiceRow}>
              <span className={styles.voiceLabel}>Hear it from your coach</span>
              <select
                className={styles.languageSelect}
                value={voiceLanguage}
                onChange={(e) => changeVoiceLanguage(e.target.value)}
                aria-label="Language for the spoken coaching"
                title="Language for the spoken coaching"
              >
                {VOICE_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <VoiceCoachButton
                sessionId={sessionId}
                englishScript={report.voiceScript}
                languageCode={voiceLanguage}
                languageLabel={VOICE_LANGUAGES.find((l) => l.code === voiceLanguage)?.label ?? voiceLanguage}
              />
            </div>
          )}
        </div>
      </motion.section>

      <motion.section variants={FADE_UP} className={styles.card}>
        <h4 className={styles.cardTitle}>
          <FiEye aria-hidden /> Skill breakdown
          <span className={styles.cardHint}>Select a skill to see why</span>
        </h4>
        <ul className={styles.categoryList}>
          {report.categoryScores.map((c, index) => {
            const open = openCategory === c.category;
            const barTone = notScored ? 'muted' : scoreTone(c.score);
            return (
              <li key={c.category} className={styles.category}>
                <button
                  type="button"
                  className={styles.categoryButton}
                  aria-expanded={open}
                  onClick={() => setOpenCategory(open ? null : c.category)}
                >
                  <span className={styles.categoryName}>{CATEGORY_LABEL[c.category]}</span>
                  <span className={styles.barTrack}>
                    <motion.span
                      className={clsx(styles.barFill, styles[`bar_${barTone}`])}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, Math.max(0, c.score * 10))}%` }}
                      transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.25 + index * 0.07 }}
                    />
                  </span>
                  <span className={styles.categoryScore}>
                    {c.score}
                    <small>/10</small>
                  </span>
                  <FiChevronDown className={clsx(styles.chevron, open && styles.chevronOpen)} aria-hidden />
                </button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.p
                      className={styles.rationale}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={SPRING_SOFT}
                    >
                      {c.rationale}
                    </motion.p>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      </motion.section>

      {(report.whatWentWell.length > 0 ||
        report.whatToImprove.length > 0 ||
        report.whatWouldHaveDoneDifferently.length > 0 ||
        report.nextCallFocus.length > 0) && (
        <motion.div variants={FADE_UP} className={styles.coachGrid}>
          <FeedbackCard tone="success" icon={<FiCheck />} title="What you did well" items={report.whatWentWell} />
          <FeedbackCard
            tone="warning"
            icon={<FiTrendingUp />}
            title="Where you can improve"
            items={report.whatToImprove}
          />
          <FeedbackCard
            tone="info"
            icon={<FiCompass />}
            title="What I would have done differently"
            items={report.whatWouldHaveDoneDifferently}
          />
          <FeedbackCard
            tone="accent"
            icon={<FiTarget />}
            title="Focus for your next call"
            items={report.nextCallFocus}
          />
        </motion.div>
      )}

      {report.keyMoments.length > 0 && (
        <motion.section variants={FADE_UP} className={styles.card}>
          <h4 className={styles.cardTitle}>
            <FiTarget aria-hidden /> Key moments
          </h4>
          <motion.ol className={styles.timeline} variants={staggerChildren(0.07)} initial="hidden" animate="show">
            {report.keyMoments.map((moment, i) => {
              const meta = MOMENT_META[moment.momentType];
              const Icon = meta.icon;
              const time = formatElapsed(moment.occurredAt, createdAt);
              return (
                <motion.li key={i} className={clsx(styles.moment, styles[meta.tone])} variants={ROW_IN}>
                  <span className={styles.momentDot} aria-hidden>
                    <Icon />
                  </span>
                  <div className={styles.momentBody}>
                    <div className={styles.momentHeader}>
                      <span className={styles.momentLabel}>{meta.label}</span>
                      {time && <span className={styles.momentTime}>at {time}</span>}
                    </div>
                    <p className={styles.momentText}>{moment.text}</p>
                    {moment.recommendation && (
                      <p className={styles.momentTip}>
                        <FiArrowRight aria-hidden /> {moment.recommendation}
                      </p>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </motion.ol>
        </motion.section>
      )}

      {report.coachingSummary && (
        <motion.figure variants={FADE_UP} className={styles.summary}>
          <FiMessageSquare className={styles.summaryIcon} aria-hidden />
          <figcaption className={styles.summaryLabel}>Coach&apos;s summary</figcaption>
          <blockquote className={styles.summaryText}>{report.coachingSummary}</blockquote>
        </motion.figure>
      )}
    </motion.div>
  );
}

function FeedbackCard({ tone, icon, title, items }: { tone: Tone; icon: ReactNode; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className={clsx(styles.feedback, styles[tone])}>
      <h4 className={styles.feedbackTitle}>
        <span className={styles.feedbackIcon} aria-hidden>
          {icon}
        </span>
        {title}
      </h4>
      <ul className={styles.list}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
