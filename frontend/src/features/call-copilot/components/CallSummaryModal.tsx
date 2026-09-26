import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  FiAlertTriangle,
  FiAward,
  FiCheckCircle,
  FiCopy,
  FiFile,
  FiFileText,
  FiHeadphones,
  FiMessageSquare,
  FiMic,
  FiPhoneCall,
  FiSearch,
  FiTarget,
  FiUploadCloud,
} from 'react-icons/fi';
import { Modal, Spinner } from '@/components/ui';
import {
  callCopilotService,
  type CallFollowUpAction,
  type CallSummaryResult,
  type CallTranscriptSegment,
  type CoachingReport,
} from '@/services/callCopilotService';
import { OUTCOME_META, describeSource, formatCallDate, type CallKind } from '../callMeta';
import { EASE_OUT, FADE_UP, ROW_IN, staggerChildren } from '../motion';
import { AiCoachPanel } from './AiCoachPanel';
import { PillTabs, type PillTabItem } from './PillTabs';
import { SentimentIndicator } from './SentimentIndicator';
import styles from './CallSummaryModal.module.css';

const PRIORITY_LABEL: Record<CallFollowUpAction['priority'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const KIND_ICON: Record<CallKind, ReactNode> = {
  live: <FiMic />,
  phone: <FiPhoneCall />,
  upload: <FiUploadCloud />,
};

export interface CallSummaryModalProps {
  open: boolean;
  onClose: () => void;
  source?: 'live' | 'upload';
  originalFilename?: string;
  // The summary itself — headline, points, needs, concerns, takeaways and follow-ups.
  summaryResult: CallSummaryResult | null;
  // Optional richer data — only ever available when reviewing a call fetched
  // from the Library (getSession() returns full segments), never for a live
  // call's own just-finished modal (the store only ever keeps a flat
  // concatenated transcript string). Every one of these is optional so the
  // live-call call site keeps working exactly as before.
  transcript?: string;
  segments?: CallTranscriptSegment[];
  // Identifies the recording(s) to fetch for playback (see AudioPlayer
  // below, which fetches them as authenticated blobs) — sessionId only;
  // WHICH file(s) to play is derived from segments' own audioFileId values
  // below, never a ready-to-use URL (the streaming endpoint sits behind
  // JwtAuthGuard and a plain <audio src> request carries no auth header at
  // all).
  sessionId?: string;
  // AI Sales Coach — all optional so every existing call site keeps working
  // unchanged; a caller that doesn't pass these simply never shows the tab.
  createdAt?: string;
  sentiment?: string | null;
  coachingPending?: boolean;
  coaching?: CoachingReport | null;
  onCoachingGenerated?: (report: CoachingReport) => void;
}

function hasSummaryContent(result: CallSummaryResult | null): boolean {
  if (!result) return false;
  return !!(
    result.headline ||
    result.summary ||
    result.summaryPoints?.length ||
    result.customerNeeds?.length ||
    result.concernsRaised?.length ||
    result.keyTakeaways?.length ||
    result.followUpActions?.length
  );
}

// Display-only, by design — follow-up actions are shown for the salesperson
// to action themselves; nothing here writes to the CRM automatically (per
// the confirmed requirement).
export function CallSummaryModal({
  open,
  onClose,
  source,
  originalFilename,
  summaryResult,
  transcript,
  segments,
  sessionId,
  createdAt,
  sentiment,
  coachingPending,
  coaching,
  onCoachingGenerated,
}: CallSummaryModalProps) {
  const hasOverview = hasSummaryContent(summaryResult);
  const hasTranscript = !!(transcript || segments?.length);
  const [tab, setTab] = useState(hasOverview ? 'overview' : 'coach');

  // Each time the dialog opens it starts where the answer is: the summary if
  // there is one (it's ready the moment the call ends), else the coach.
  useEffect(() => {
    if (open) setTab(hasOverview ? 'overview' : 'coach');
    // Only when it opens or a different call is loaded — not when data streams in behind an open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  const tabs: PillTabItem[] = useMemo(() => {
    const items: PillTabItem[] = [];
    if (hasOverview) items.push({ id: 'overview', label: 'Overview', icon: <FiFileText aria-hidden /> });
    items.push({ id: 'coach', label: 'AI Coach', icon: <FiAward aria-hidden />, busy: !!coachingPending && !coaching });
    if (hasTranscript) items.push({ id: 'transcript', label: 'Transcript', icon: <FiMessageSquare aria-hidden /> });
    return items;
  }, [hasOverview, hasTranscript, coachingPending, coaching]);

  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const kind = describeSource(source, originalFilename);
  const outcome = summaryResult?.outcome ? OUTCOME_META[summaryResult.outcome] : undefined;

  return (
    <Modal open={open} onClose={onClose} title="Call Summary" maxWidth={860}>
      <div className={styles.body}>
        {(source || outcome || sentiment) && (
          <div className={styles.header}>
            <div className={styles.chips}>
              {source && (
                <span className={clsx(styles.chip, styles.kind)}>
                  {KIND_ICON[kind.kind]} {kind.label}
                </span>
              )}
              {outcome && <span className={clsx(styles.chip, styles[outcome.tone])}>{outcome.label}</span>}
              {sentiment && <SentimentIndicator sentiment={sentiment} />}
              {createdAt && <span className={styles.date}>{formatCallDate(createdAt)}</span>}
            </div>
            {summaryResult?.headline && <h3 className={styles.headline}>{summaryResult.headline}</h3>}
            {originalFilename && kind.kind === 'upload' && (
              <span className={styles.filename}>
                <FiFile aria-hidden /> {originalFilename}
              </span>
            )}
          </div>
        )}

        {tabs.length > 1 && <PillTabs ariaLabel="Call summary sections" items={tabs} activeId={activeTab} onChange={setTab} size="sm" />}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            {activeTab === 'overview' && summaryResult && <OverviewTab result={summaryResult} />}

            {activeTab === 'coach' && (
              <AiCoachPanel
                sessionId={sessionId}
                createdAt={createdAt}
                pending={coachingPending}
                coaching={coaching}
                onGenerated={onCoachingGenerated}
              />
            )}

            {activeTab === 'transcript' && (
              <TranscriptTab transcript={transcript} segments={segments} sessionId={sessionId} isUpload={source === 'upload'} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- overview

function OverviewTab({ result }: { result: CallSummaryResult }) {
  const points = result.summaryPoints ?? [];
  const needs = result.customerNeeds ?? [];
  const concerns = result.concernsRaised ?? [];
  const takeaways = result.keyTakeaways ?? [];

  return (
    <motion.div className={styles.overview} variants={staggerChildren(0.07)} initial="hidden" animate="show">
      {points.length > 0 ? (
        <motion.section variants={FADE_UP}>
          <h4 className={styles.sectionTitle}>What happened</h4>
          <ul className={styles.bullets}>
            {points.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </motion.section>
      ) : (
        result.summary && (
          <motion.section variants={FADE_UP}>
            <h4 className={styles.sectionTitle}>What happened</h4>
            <p className={styles.paragraph}>{result.summary}</p>
          </motion.section>
        )
      )}

      {(needs.length > 0 || concerns.length > 0) && (
        <motion.div variants={FADE_UP} className={styles.twoCol}>
          <InfoList tone="info" icon={<FiTarget />} title="What the customer needs" items={needs} />
          <InfoList tone="warning" icon={<FiAlertTriangle />} title="Concerns raised" items={concerns} />
        </motion.div>
      )}

      {takeaways.length > 0 && (
        <motion.section variants={FADE_UP} className={styles.takeaways}>
          <h4 className={styles.takeawaysTitle}>
            <FiCheckCircle aria-hidden /> Key takeaways
          </h4>
          <ul className={styles.takeawayList}>
            {takeaways.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </motion.section>
      )}

      <FollowUpSection followUpActions={result.followUpActions ?? []} />
    </motion.div>
  );
}

function InfoList({ tone, icon, title, items }: { tone: 'info' | 'warning'; icon: ReactNode; title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className={clsx(styles.infoCard, styles[tone])}>
      <h4 className={styles.infoTitle}>
        <span className={styles.infoIcon} aria-hidden>
          {icon}
        </span>
        {title}
      </h4>
      <ul className={styles.bullets}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function FollowUpSection({ followUpActions }: { followUpActions: CallFollowUpAction[] }) {
  if (followUpActions.length === 0) return null;
  const bySalesperson = followUpActions.filter((a) => (a.owner ?? 'salesperson') === 'salesperson');
  const byCustomer = followUpActions.filter((a) => a.owner === 'customer');

  return (
    <motion.section variants={FADE_UP}>
      <h4 className={styles.sectionTitle}>Suggested follow-ups</h4>
      <p className={styles.hint}>These are not created in your CRM automatically — add the ones you want yourself.</p>
      {bySalesperson.length > 0 && (
        <div className={styles.followUpGroup}>
          <span className={styles.followUpGroupLabel}>You</span>
          <motion.ul className={styles.followUpList} variants={staggerChildren(0.05)}>
            {bySalesperson.map((action, i) => (
              <FollowUpRow key={i} action={action} />
            ))}
          </motion.ul>
        </div>
      )}
      {byCustomer.length > 0 && (
        <div className={styles.followUpGroup}>
          <span className={styles.followUpGroupLabel}>Customer</span>
          <motion.ul className={styles.followUpList} variants={staggerChildren(0.05)}>
            {byCustomer.map((action, i) => (
              <FollowUpRow key={i} action={action} />
            ))}
          </motion.ul>
        </div>
      )}
    </motion.section>
  );
}

async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.error("Couldn't copy — select the text and copy it instead.");
  }
}

function FollowUpRow({ action }: { action: CallFollowUpAction }) {
  return (
    <motion.li className={styles.followUpRow} variants={ROW_IN}>
      <span className={clsx(styles.priority, styles[`priority_${action.priority}`])}>{PRIORITY_LABEL[action.priority]}</span>
      <span className={styles.followUpText}>{action.text}</span>
      <button
        type="button"
        className={styles.copyButton}
        aria-label="Copy follow-up"
        title="Copy follow-up"
        onClick={() => void copyText(action.text, 'Follow-up copied')}
      >
        <FiCopy />
      </button>
    </motion.li>
  );
}

// -------------------------------------------------------------- transcript

interface Turn {
  speaker?: string;
  side: 'a' | 'b';
  text: string;
}

// One bubble per stretch of speech: consecutive segments from the same speaker
// join up (a live call arrives in ~7-second clips, which would otherwise be a
// bubble each). Speakers take turns on the left and right.
function buildTurns(segments: CallTranscriptSegment[]): Turn[] {
  const order: string[] = [];
  const turns: Turn[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const speaker = segment.speaker;
    if (speaker !== undefined && !order.includes(speaker)) order.push(speaker);
    const side = speaker !== undefined && order.indexOf(speaker) % 2 === 1 ? 'b' : 'a';
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += ` ${segment.text}`;
    else turns.push({ speaker, side, text: segment.text });
  }
  return turns;
}

function speakerLabel(speaker: string): string {
  return /^\d+$/.test(speaker) ? `Speaker ${Number(speaker) + 1}` : speaker;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  return text
    .split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'))
    .map((part, i) => (part.toLowerCase() === needle.toLowerCase() ? <mark key={i} className={styles.mark}>{part}</mark> : part));
}

function TranscriptTab({
  transcript,
  segments,
  sessionId,
  isUpload,
}: {
  transcript?: string;
  segments?: CallTranscriptSegment[];
  sessionId?: string;
  isUpload: boolean;
}) {
  const [query, setQuery] = useState('');

  // Ordered, deduped list of every segment's audioFileId — for a live call
  // this is every ~7s clip in sequence (AudioPlayer plays them back-to-back
  // for continuous full-call playback); for an uploaded call every segment
  // already shares the SAME id (the one original file), so this naturally
  // collapses to a single-element list with no special-casing needed here.
  const audioFileIds = useMemo(() => {
    if (!segments?.length) return [];
    const ids: string[] = [];
    for (const s of segments) {
      if (s.audioFileId && ids[ids.length - 1] !== s.audioFileId) ids.push(s.audioFileId);
    }
    return ids;
  }, [segments]);

  const turns = useMemo(() => (segments?.length ? buildTurns(segments) : []), [segments]);
  const fullText = turns.length > 0 ? turns.map((t) => t.text).join('\n') : (transcript ?? '');
  const matchCount = useMemo(() => {
    const needle = query.trim();
    if (!needle) return 0;
    return (fullText.match(new RegExp(escapeRegExp(needle), 'gi')) ?? []).length;
  }, [fullText, query]);

  return (
    <div className={styles.transcriptSection}>
      {sessionId && audioFileIds.length > 0 && (
        <div className={styles.audioCard}>
          <span className={styles.audioLabel}>
            <FiHeadphones aria-hidden /> Recording
          </span>
          <AudioPlayer sessionId={sessionId} audioFileIds={audioFileIds} />
          {isUpload && <span className={styles.hint}>One recording for the whole call.</span>}
        </div>
      )}

      {fullText && (
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <FiSearch aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this transcript"
              aria-label="Search this transcript"
            />
            {query.trim() && (
              <span className={styles.matchCount} aria-live="polite">
                {matchCount === 0 ? 'No matches' : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
              </span>
            )}
          </label>
          <button type="button" className={styles.copyAll} onClick={() => void copyText(fullText, 'Transcript copied')}>
            <FiCopy aria-hidden /> Copy
          </button>
        </div>
      )}

      {turns.length > 0 ? (
        <motion.div className={styles.turns} variants={staggerChildren(0.03, 0)} initial="hidden" animate="show">
          {turns.map((turn, i) => (
            <motion.div key={i} className={clsx(styles.turn, turn.side === 'b' && styles.turnB)} variants={FADE_UP}>
              {turn.speaker !== undefined && <span className={styles.speakerLabel}>{speakerLabel(turn.speaker)}</span>}
              <div className={styles.bubble}>{highlight(turn.text, query)}</div>
            </motion.div>
          ))}
        </motion.div>
      ) : (
        <p className={styles.paragraph}>{transcript ? highlight(transcript, query) : 'No transcript was captured for this call.'}</p>
      )}
    </div>
  );
}

// Fetches each recording file as an authenticated blob (see
// callCopilotService.getAudioBlob's own comment on why a plain <audio
// src="..."> can't hit this JwtAuthGuard-protected endpoint directly) and
// plays it from a local object URL — same pattern VoiceInputModal.tsx's
// playBlob already uses for TTS playback.
//
// A live call has NO single continuous recording — every ~7s segment is its
// own independently-valid file (see call-copilot.gateway.ts's comment on
// why: stop/restart MediaRecorder instances can't be byte-concatenated into
// one valid container). Playing only audioFileIds[0] plays just the first
// ~7 seconds, not the call. This plays the list back-to-back instead —
// advancing on 'ended' — which gives continuous full-call playback without
// server-side re-encoding/ffmpeg. An upload has exactly one file
// (audioFileIds.length === 1) and this collapses to a plain single player.
function AudioPlayer({ sessionId, audioFileIds }: { sessionId: string; audioFileIds: string[] }) {
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setIndex(0);
  }, [sessionId, audioFileIds]);

  useEffect(() => {
    const fileId = audioFileIds[index];
    if (!fileId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);

    callCopilotService
      .getAudioBlob(sessionId, fileId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, audioFileIds, index]);

  if (failed) return <p className={styles.hint}>The recording couldn&apos;t be loaded.</p>;
  if (!url) return <Spinner size={16} />;
  return (
    <div className={styles.audioPlayerWrap}>
      <audio
        controls
        autoPlay={index > 0}
        src={url}
        className={styles.audioPlayer}
        onEnded={() => setIndex((i) => (i + 1 < audioFileIds.length ? i + 1 : i))}
      />
      {audioFileIds.length > 1 && (
        <span className={styles.hint}>
          Part {index + 1} of {audioFileIds.length} — plays through automatically
        </span>
      )}
    </div>
  );
}
