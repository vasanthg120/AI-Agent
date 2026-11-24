import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
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
  FiPlay,
  FiSearch,
  FiTarget,
  FiUploadCloud,
  FiUser,
} from 'react-icons/fi';
import { Modal } from '@/components/ui';
import {
  type CallFollowUpAction,
  type CallSummaryResult,
  type CallTranscriptSegment,
  type CoachingReport,
} from '@/services/callCopilotService';
import { OUTCOME_META, describeSource, formatCallDate, type CallKind } from '../callMeta';
import { RecordingPlayer, type RecordingPlayerHandle } from './recording/RecordingPlayer';
import { EASE_OUT, FADE_UP, ROW_IN, staggerChildren } from '../motion';
import { AiCoachPanel } from './AiCoachPanel';
import { CustomerSnapshotCard, useCustomerSnapshot } from './CustomerSnapshotCard';
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
  // Someone else's call, opened from the team view: shown to read. Coaching and
  // the spoken coach stay with the person who made it (they bill their business).
  readOnly?: boolean;
  ownerName?: string;
  businessName?: string;
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
  readOnly,
  ownerName,
  businessName,
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

  // Who the call was with, when HaiVE knows the customer (by the call's number or deal).
  const snapshot = useCustomerSnapshot({ sessionId: open ? sessionId : undefined });
  const hasCustomer = snapshot.data?.found === true && !('restricted' in snapshot.data && snapshot.data.restricted);

  const tabs: PillTabItem[] = useMemo(() => {
    const items: PillTabItem[] = [];
    if (hasOverview) items.push({ id: 'overview', label: 'Overview', icon: <FiFileText aria-hidden /> });
    if (hasCustomer) items.push({ id: 'customer', label: 'Customer', icon: <FiUser aria-hidden /> });
    items.push({ id: 'coach', label: 'AI Coach', icon: <FiAward aria-hidden />, busy: !!coachingPending && !coaching });
    if (hasTranscript) items.push({ id: 'transcript', label: 'Transcript', icon: <FiMessageSquare aria-hidden /> });
    return items;
  }, [hasOverview, hasCustomer, hasTranscript, coachingPending, coaching]);

  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const kind = describeSource(source, originalFilename);
  const outcome = summaryResult?.outcome ? OUTCOME_META[summaryResult.outcome] : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ownerName ? `Call by ${ownerName}` : 'Call Summary'}
      description={businessName}
      maxWidth={860}
    >
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

        {tabs.length > 1 && (
          <PillTabs ariaLabel="Call summary sections" items={tabs} activeId={activeTab} onChange={setTab} size="sm" />
        )}

        <>
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            {activeTab === 'overview' && summaryResult && <OverviewTab result={summaryResult} />}

            {activeTab === 'customer' && sessionId && <CustomerSnapshotCard sessionId={sessionId} defaultExpanded />}

            {activeTab === 'coach' && (
              <AiCoachPanel
                sessionId={sessionId}
                createdAt={createdAt}
                pending={coachingPending}
                coaching={coaching}
                onGenerated={onCoachingGenerated}
                readOnly={readOnly}
                ownerName={ownerName}
              />
            )}

            {activeTab === 'transcript' && (
              <TranscriptTab
                transcript={transcript}
                segments={segments}
                sessionId={sessionId}
                isUpload={source === 'upload'}
                createdAt={createdAt}
                speakerRoles={coaching?.evaluation?.understanding?.speakers}
              />
            )}
          </motion.div>
        </>
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

function InfoList({
  tone,
  icon,
  title,
  items,
}: {
  tone: 'info' | 'warning';
  icon: ReactNode;
  title: string;
  items: string[];
}) {
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
      <span className={clsx(styles.priority, styles[`priority_${action.priority}`])}>
        {PRIORITY_LABEL[action.priority]}
      </span>
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
  // Seconds into the call the turn starts (the Call Intelligence report quotes the same times).
  at?: number;
}

// One bubble per stretch of speech: consecutive segments from the same speaker
// join up (a live call arrives in ~7-second clips, which would otherwise be a
// bubble each). Speakers take turns on the left and right. A turn's time is its
// first segment's: Sarvam's start time for a recording, or — for a live call —
// when the previous clip arrived, from the start of the call (as the backend's
// call-intelligence.ts works it out, so the report's quotes and these agree).
const UNLABELLED_BLOCK_SECONDS = 20;

function buildTurns(segments: CallTranscriptSegment[], createdAt?: string, starts: Record<string, number> = {}): Turn[] {
  const order: string[] = [];
  const turns: Turn[] = [];
  const start = createdAt ? new Date(createdAt).getTime() : undefined;
  let previousArrival: number | undefined;
  for (const segment of [...segments].sort((a, b) => a.sequence - b.sequence)) {
    const arrival = segment.recordedAt ? new Date(segment.recordedAt).getTime() : undefined;
    // Its place in the recording when known exactly (the joined recording), else its own timing, else when it arrived.
    const inRecording = starts[String(segment.sequence)];
    const at =
      typeof inRecording === 'number'
        ? inRecording
        : typeof segment.startSeconds === 'number'
        ? segment.startSeconds
        : segment.speaker === undefined && start !== undefined
          ? previousArrival === undefined
            ? 0
            : Math.max(0, Math.round((previousArrival - start) / 1000))
          : undefined;
    if (arrival !== undefined) previousArrival = arrival;
    if (!segment.text) continue;
    const speaker = segment.speaker;
    if (speaker !== undefined && !order.includes(speaker)) order.push(speaker);
    const side = speaker !== undefined && order.indexOf(speaker) % 2 === 1 ? 'b' : 'a';
    const last = turns[turns.length - 1];
    // Speech with no speaker labels (a live call, one microphone) would otherwise be one bubble for the
    // whole call: a new one every ~20 seconds keeps each moment the report quotes findable by its time.
    const longUnlabelled = speaker === undefined && last?.at !== undefined && at !== undefined && at - last.at >= UNLABELLED_BLOCK_SECONDS;
    if (last && last.speaker === speaker && !longUnlabelled) last.text += ` ${segment.text}`;
    else turns.push({ speaker, side, text: segment.text, at });
  }
  return turns;
}

function speakerLabel(speaker: string, roles?: { label: string; role: string }[]): string {
  const label = /^\d+$/.test(speaker) ? `Speaker ${Number(speaker) + 1}` : speaker;
  const role = roles?.find((r) => r.label === label)?.role;
  return role === 'agent' ? `Agent (${label})` : role === 'customer' ? `Customer (${label})` : label;
}

function turnClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  return text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi')).map((part, i) =>
    part.toLowerCase() === needle.toLowerCase() ? (
      <mark key={i} className={styles.mark}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function TranscriptTab({
  transcript,
  segments,
  sessionId,
  isUpload,
  createdAt,
  speakerRoles,
}: {
  transcript?: string;
  segments?: CallTranscriptSegment[];
  sessionId?: string;
  isUpload: boolean;
  createdAt?: string;
  // Who each speaker is, as the Call Intelligence review worked out.
  speakerRoles?: { label: string; role: string }[];
}) {
  const [query, setQuery] = useState('');
  const player = useRef<RecordingPlayerHandle | null>(null);
  // Where each transcript line starts in the recording (a live call's parts joined on the server), and where playback is.
  const [starts, setStarts] = useState<Record<string, number>>({});
  const [playhead, setPlayhead] = useState<number | null>(null);

  // Every part of the call in order — only used if the server can't say what the recording is.
  const audioFileIds = useMemo(() => {
    if (!segments?.length) return [];
    const ids: string[] = [];
    for (const s of [...segments].sort((a, b) => a.sequence - b.sequence)) {
      if (s.audioFileId && !ids.includes(s.audioFileId)) ids.push(s.audioFileId);
    }
    return ids;
  }, [segments]);

  const turns = useMemo(() => (segments?.length ? buildTurns(segments, createdAt, starts) : []), [segments, createdAt, starts]);
  const fullText = turns.length > 0 ? turns.map((t) => t.text).join('\n') : (transcript ?? '');
  const matchCount = useMemo(() => {
    const needle = query.trim();
    if (!needle) return 0;
    return (fullText.match(new RegExp(escapeRegExp(needle), 'gi')) ?? []).length;
  }, [fullText, query]);

  // The line being played: the last one that has started.
  const activeTurn = useMemo(() => {
    if (playhead === null) return -1;
    let active = -1;
    turns.forEach((t, i) => {
      if (t.at !== undefined && t.at <= playhead + 0.25) active = i;
    });
    return active;
  }, [turns, playhead]);
  const turnRefs = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    if (activeTurn >= 0) turnRefs.current[activeTurn]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTurn]);

  return (
    <div className={styles.transcriptSection}>
      {sessionId && audioFileIds.length > 0 && (
        <div className={styles.audioCard}>
          <span className={styles.audioLabel}>
            <FiHeadphones aria-hidden /> {isUpload ? 'Recording' : 'Call recording'}
          </span>
          <RecordingPlayer
            ref={player}
            sessionId={sessionId}
            fallbackParts={audioFileIds}
            onInfo={(info) => setStarts(info.segmentStarts)}
            onTime={setPlayhead}
            downloadName={`call-${(createdAt ?? '').slice(0, 10) || sessionId}`}
          />
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
            <motion.div
              key={i}
              ref={(node: HTMLDivElement | null) => {
                turnRefs.current[i] = node;
              }}
              className={clsx(styles.turn, turn.side === 'b' && styles.turnB, i === activeTurn && styles.turnActive)}
              variants={FADE_UP}
            >
              {(turn.speaker !== undefined || turn.at !== undefined) && (
                <span className={styles.speakerLabel}>
                  {turn.at !== undefined &&
                    (sessionId && audioFileIds.length > 0 ? (
                      <button
                        type="button"
                        className={clsx(styles.turnTime, styles.turnSeek)}
                        onClick={() => player.current?.seek(turn.at!, true)}
                        aria-label={`Play from ${turnClock(turn.at)}`}
                        title="Play from here"
                      >
                        <FiPlay aria-hidden /> {turnClock(turn.at)}
                      </button>
                    ) : (
                      <span className={styles.turnTime}>{turnClock(turn.at)}</span>
                    ))}
                  {turn.speaker !== undefined && speakerLabel(turn.speaker, speakerRoles)}
                </span>
              )}
              <div className={styles.bubble}>{highlight(turn.text, query)}</div>
            </motion.div>
          ))}
        </motion.div>
      ) : (
        <p className={styles.paragraph}>
          {transcript ? highlight(transcript, query) : 'No transcript was captured for this call.'}
        </p>
      )}
    </div>
  );
}
