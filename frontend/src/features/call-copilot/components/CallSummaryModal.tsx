import { useEffect, useMemo, useState } from 'react';
import { Badge, Modal, SectionCard, Spinner, StatTile, Tabs } from '@/components/ui';
import type { BadgeVariant, TabItem } from '@/components/ui';
import { callCopilotService, type CallEvent, type CallFollowUpAction, type CallOutcome, type CallSummaryResult, type CallTranscriptSegment } from '@/services/callCopilotService';
import styles from './CallSummaryModal.module.css';

const PRIORITY_VARIANT: Record<CallFollowUpAction['priority'], BadgeVariant> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  moving_forward: 'Moving Forward',
  needs_follow_up: 'Needs Follow-Up',
  objection_raised: 'Objection Raised',
  no_decision: 'No Decision',
  lost: 'Lost',
  not_applicable: 'Not Applicable',
};

const OUTCOME_VARIANT: Record<CallOutcome, BadgeVariant> = {
  moving_forward: 'success',
  needs_follow_up: 'warning',
  objection_raised: 'warning',
  no_decision: 'neutral',
  lost: 'danger',
  not_applicable: 'neutral',
};

export interface CallSummaryModalProps {
  open: boolean;
  onClose: () => void;
  source?: 'live' | 'upload';
  originalFilename?: string;
  summaryResult: CallSummaryResult | null;
  // Optional richer data — only ever available when reviewing a call fetched
  // from the Library (getSession() returns full segments/events), never for
  // a live call's own just-finished modal (the store only ever keeps a flat
  // concatenated transcript string). Every one of these is optional so the
  // live-call call site keeps working exactly as before.
  transcript?: string;
  segments?: CallTranscriptSegment[];
  events?: CallEvent[];
  sentiment?: string | null;
  // Identifies the recording(s) to fetch for playback (see AudioPlayer
  // below, which fetches them as authenticated blobs) — sessionId only;
  // WHICH file(s) to play is derived from segments' own audioFileId values
  // below, never a ready-to-use URL (the streaming endpoint sits behind
  // JwtAuthGuard and a plain <audio src> request carries no auth header at
  // all).
  sessionId?: string;
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
  events,
  sentiment,
  sessionId,
}: CallSummaryModalProps) {
  const [tab, setTab] = useState('summary');
  const hasStructuredSummary = !!summaryResult?.summaryPoints?.length;

  const tabs: TabItem[] = useMemo(() => {
    const items: TabItem[] = [{ id: 'summary', label: 'Summary' }];
    if (transcript || segments?.length) items.push({ id: 'transcript', label: 'Transcript' });
    if (events?.length || sentiment) items.push({ id: 'analytics', label: 'Signals & Analytics' });
    return items;
  }, [transcript, segments, events, sentiment]);

  return (
    <Modal open={open} onClose={onClose} title="Call Summary" maxWidth={720}>
      <div className={styles.body}>
        {source && (
          <div className={styles.headerBadges}>
            <Badge variant={source === 'upload' ? 'neutral' : 'success'}>{source === 'upload' ? 'Uploaded' : 'Live'}</Badge>
            {originalFilename && <span className={styles.filename}>{originalFilename}</span>}
          </div>
        )}

        {tabs.length > 1 && <Tabs items={tabs} activeId={tab} onChange={setTab} />}

        {tab === 'summary' && (
          <SummaryTab summaryResult={summaryResult} hasStructuredSummary={hasStructuredSummary} />
        )}

        {tab === 'transcript' && (
          <TranscriptTab
            transcript={transcript}
            segments={segments}
            sessionId={sessionId}
            isUpload={source === 'upload'}
          />
        )}

        {tab === 'analytics' && <AnalyticsTab events={events ?? []} sentiment={sentiment} />}
      </div>
    </Modal>
  );
}

function SummaryTab({ summaryResult, hasStructuredSummary }: { summaryResult: CallSummaryResult | null; hasStructuredSummary: boolean }) {
  if (!hasStructuredSummary) {
    // Fallback for a session ended before the structured summary shipped —
    // renders the old single-paragraph shape unchanged, never a crash.
    return (
      <div className={styles.summarySection}>
        <p className={styles.summary}>{summaryResult?.summary || 'No summary was generated for this call.'}</p>
        <FollowUpSection followUpActions={summaryResult?.followUpActions ?? []} />
      </div>
    );
  }

  return (
    <div className={styles.summarySection}>
      {summaryResult?.headline && <p className={styles.headline}>{summaryResult.headline}</p>}
      {summaryResult?.outcome && <Badge variant={OUTCOME_VARIANT[summaryResult.outcome]}>{OUTCOME_LABEL[summaryResult.outcome]}</Badge>}

      {!!summaryResult?.summaryPoints.length && (
        <ul className={styles.list}>
          {summaryResult.summaryPoints.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}

      <div className={styles.twoColumn}>
        {!!summaryResult?.customerNeeds.length && (
          <SectionCard title="Customer Needs">
            <ul className={styles.list}>
              {summaryResult.customerNeeds.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </SectionCard>
        )}
        {!!summaryResult?.concernsRaised.length && (
          <SectionCard title="Concerns Raised">
            <ul className={styles.list}>
              {summaryResult.concernsRaised.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </SectionCard>
        )}
      </div>

      {!!summaryResult?.keyTakeaways.length && (
        <div>
          <h4 className={styles.sectionTitle}>Key Takeaways</h4>
          <ul className={styles.list}>
            {summaryResult.keyTakeaways.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      )}

      <FollowUpSection followUpActions={summaryResult?.followUpActions ?? []} />
    </div>
  );
}

function FollowUpSection({ followUpActions }: { followUpActions: CallFollowUpAction[] }) {
  if (followUpActions.length === 0) return null;
  const bySalesperson = followUpActions.filter((a) => (a.owner ?? 'salesperson') === 'salesperson');
  const byCustomer = followUpActions.filter((a) => a.owner === 'customer');

  return (
    <div>
      <h4 className={styles.sectionTitle}>Suggested Follow-Ups</h4>
      <p className={styles.hint}>These are not created in your CRM automatically — add the ones you want yourself.</p>
      {bySalesperson.length > 0 && (
        <div className={styles.followUpGroup}>
          <span className={styles.followUpGroupLabel}>You</span>
          <div className={styles.followUpList}>
            {bySalesperson.map((action, i) => (
              <FollowUpRow key={i} action={action} />
            ))}
          </div>
        </div>
      )}
      {byCustomer.length > 0 && (
        <div className={styles.followUpGroup}>
          <span className={styles.followUpGroupLabel}>Customer</span>
          <div className={styles.followUpList}>
            {byCustomer.map((action, i) => (
              <FollowUpRow key={i} action={action} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FollowUpRow({ action }: { action: CallFollowUpAction }) {
  return (
    <div className={styles.followUpRow}>
      <Badge variant={PRIORITY_VARIANT[action.priority]}>{action.priority}</Badge>
      <span>{action.text}</span>
    </div>
  );
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

  return (
    <div className={styles.transcriptSection}>
      {sessionId && audioFileIds.length > 0 && (
        <div className={styles.audioRow}>
          <AudioPlayer sessionId={sessionId} audioFileIds={audioFileIds} />
          {isUpload && <span className={styles.hint}>One recording for the whole call.</span>}
        </div>
      )}
      {segments?.length ? (
        <div className={styles.segmentList}>
          {segments
            .filter((s) => s.text)
            .map((s) => (
              <div key={s.sequence} className={styles.segmentRow}>
                {s.speaker !== undefined && <span className={styles.speakerLabel}>Speaker {s.speaker}</span>}
                <span>{s.text}</span>
              </div>
            ))}
        </div>
      ) : (
        <p className={styles.summary}>{transcript || 'No transcript was captured for this call.'}</p>
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

function AnalyticsTab({ events, sentiment }: { events: CallEvent[]; sentiment?: string | null }) {
  const countByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return counts;
  }, [events]);

  return (
    <div className={styles.analyticsGrid}>
      <StatTile label="Sentiment" value={sentiment ?? '—'} />
      <StatTile label="Objections" value={countByType.get('objection') ?? 0} />
      <StatTile label="Buying Signals" value={countByType.get('buying_signal') ?? 0} />
      <StatTile label="Competitor Mentions" value={countByType.get('competitor') ?? 0} />
    </div>
  );
}
