import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { OUTCOME_META } from '@/features/call-copilot/callMeta';
import { AiCoachPanel } from '@/features/call-copilot/components/AiCoachPanel';
import { PillTabs } from '@/features/call-copilot/components/PillTabs';
import { ScoreRing, scoreBand } from '@/features/call-copilot/components/ScoreRing';
import { SentimentIndicator } from '@/features/call-copilot/components/SentimentIndicator';
import { TranscriptPanel } from '@/features/call-copilot/components/TranscriptPanel';
import { callCopilotService, hasCoachingReport, type CallSessionDetail, type CoachingReport } from '@/services/callCopilotService';
import { callingService, type CallingCall, type CallingProvider } from '@/services/callingService';
import { extractErrorMessage } from '@/utils/errors';
import { FiAlertTriangle, FiArrowLeft } from '../../components/icons';
import { ReportSteps } from '../../components/ReportSteps';
import { ActionButton, StateScreen } from '../../components/StateScreen';
import { ScreenLoading } from '../../layout/DialerLayout';
import { useDialerAccess } from '../../lib/access';
import { callName, duration } from '../../lib/callText';
import { formatNumber } from '../../lib/dialRules';
import { useCalls } from '../../lib/useCalls';
import styles from './ReportScreen.module.css';

// The AI Coach follows the summary by a minute or so; past this it isn't coming
// on its own (the Coaching tab then offers to make it).
const COACHING_WAIT_MS = 5 * 60_000;

type Tab = 'summary' | 'coaching' | 'transcript';

function stillScoring(session: CallSessionDetail): boolean {
  if (hasCoachingReport(session) || session.status !== 'ended') return false;
  return !session.endedAt || Date.now() - new Date(session.endedAt).getTime() < COACHING_WAIT_MS;
}

/** The recording, fetched with the session's sign-in (a plain audio link can't carry it). */
function RecordingPlayer({ sessionId, fileId }: { sessionId: string; fileId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
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
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, fileId]);
  if (failed) return <p className={styles.muted}>The recording couldn’t be loaded.</p>;
  if (!url) return <p className={styles.muted}>Loading the recording…</p>;
  return <audio className={styles.audio} controls preload="metadata" src={url} aria-label="Call recording" />;
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.block}>
      <h3>{title}</h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One call's report: its score, summary, takeaways, sentiment, AI coaching,
 * transcript and recording. Opened from a call (/report/plivo/<id>) or from a
 * "report ready" notification (/report/session/<sessionId>). While the report
 * is still being made it shows how far along it is.
 */
export function ReportScreen() {
  const params = useParams<{ provider?: CallingProvider; id?: string; sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canPlace } = useDialerAccess();
  const [tab, setTab] = useState<Tab>('summary');
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The call: asked for directly, or (from a notification) found by its report.
  const byCall = !!params.provider && !!params.id;
  const callQuery = useQuery({
    queryKey: ['dialer', 'call', params.provider, params.id],
    queryFn: () => callingService.getCall(params.provider!, params.id!),
    enabled: byCall,
    refetchInterval: (q) => {
      const report = q.state.data?.report;
      return report?.stage === 'ready' || report?.stage === 'failed' || q.state.data?.importStatus === 'failed' ? false : 4000;
    },
  });
  const { calls } = useCalls();
  const call: CallingCall | undefined = byCall ? callQuery.data : calls.find((c) => c.sessionId === params.sessionId);
  const sessionId = params.sessionId ?? call?.sessionId;

  const sessionQuery = useQuery({
    queryKey: ['dialer', 'session', sessionId],
    queryFn: () => callCopilotService.getSession(sessionId!),
    enabled: !!sessionId,
    refetchInterval: (q) => {
      const session = q.state.data;
      if (!session) return 5000;
      return session.status === 'processing' || session.status === 'active' || stillScoring(session) ? 4000 : false;
    },
  });
  const session = sessionQuery.data;

  const transcript = useMemo(
    () =>
      (session?.transcript ?? [])
        .map((segment) => segment.text)
        .filter(Boolean)
        .join('\n\n'),
    [session],
  );

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/scores'));
  const retry = async () => {
    if (!call) return;
    setRetrying(true);
    setError(null);
    try {
      await callingService.retryImport(call);
      await Promise.all([callQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['dialer', 'calls'] })]);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  const header = (
    <header className={styles.top}>
      <button type="button" className={styles.back} onClick={back} aria-label="Back">
        <FiArrowLeft />
      </button>
      <div className={styles.who}>
        <h1>{call ? callName(call) : 'Call report'}</h1>
        {call && (
          <p>
            {call.customerName ? `${formatNumber(call.customerNumber)} · ` : ''}
            {new Date(call.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            {call.durationSeconds ? ` · ${duration(call.durationSeconds)}` : ''}
          </p>
        )}
      </div>
    </header>
  );

  if ((byCall && callQuery.isError) || (sessionQuery.isError && !session)) {
    return (
      <div className={styles.screen}>
        {header}
        <StateScreen icon={<FiAlertTriangle />} tone="warning" title="Couldn’t load this report" actions={<ActionButton onClick={back}>Back</ActionButton>}>
          <p>{extractErrorMessage(callQuery.error ?? sessionQuery.error)}</p>
        </StateScreen>
      </div>
    );
  }
  if ((byCall && !call) || (sessionId && !session)) {
    return (
      <div className={styles.screen}>
        {header}
        <ScreenLoading />
      </div>
    );
  }

  // No report yet (or it's still being transcribed): how far along it is.
  if (!session || session.status === 'processing' || session.status === 'active' || session.status === 'error') {
    return (
      <div className={styles.screen}>
        {header}
        <main className={styles.pending}>
          {call ? (
            <ReportSteps call={call} onRetry={canPlace ? () => void retry() : undefined} retrying={retrying} onOpen={() => undefined} />
          ) : (
            <p className={styles.muted}>Transcribing the call…</p>
          )}
          {call && call.outcome?.stage === 'failed' && <p className={styles.muted}>{call.outcome.message} There’s no recording to report on.</p>}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </main>
      </div>
    );
  }

  const coaching: CoachingReport | null = hasCoachingReport(session) ? session : null;
  const outcome = session.outcome ? OUTCOME_META[session.outcome] : undefined;
  const summaryPoints = session.summaryPoints?.length ? session.summaryPoints : session.summary ? [session.summary] : [];
  const nextSteps = (session.followUpActions ?? []).map((action) => (action.owner === 'customer' ? `Customer: ${action.text}` : action.text));

  return (
    <div className={styles.screen}>
      {header}
      <main className={styles.body}>
        <section className={styles.hero} aria-label="Score">
          {coaching?.overallScore !== undefined ? (
            <div className={styles.ring}>
              <ScoreRing value={coaching.overallScore} size={104} strokeWidth={9} />
              <span className={styles.band}>{scoreBand(coaching.overallScore)}</span>
            </div>
          ) : (
            <div className={styles.ring}>
              <span className={styles.noScore}>{stillScoring(session) ? 'Scoring…' : 'Not scored'}</span>
            </div>
          )}
          <div className={styles.heroText}>
            {session.headline && <h2>{session.headline}</h2>}
            <div className={styles.chips}>
              {outcome && <span className={`${styles.chip} ${styles[outcome.tone]}`}>{outcome.label}</span>}
              {session.sentiment && <SentimentIndicator sentiment={session.sentiment} />}
            </div>
          </div>
        </section>

        <PillTabs
          ariaLabel="Report"
          activeId={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: 'summary', label: 'Summary' },
            { id: 'coaching', label: 'Coaching', busy: !coaching && stillScoring(session) },
            { id: 'transcript', label: 'Transcript' },
          ]}
        />

        <div className={styles.panel} role="tabpanel" aria-label={tab === 'summary' ? 'Summary' : tab === 'coaching' ? 'Coaching' : 'Transcript'}>
          {tab === 'summary' && (
            <>
              {session.originalRecordingFileId && (
                <section className={styles.block}>
                  <h3>Recording</h3>
                  <RecordingPlayer sessionId={session._id} fileId={session.originalRecordingFileId} />
                </section>
              )}
              <List title="Summary" items={summaryPoints} />
              <List title="Key takeaways" items={session.keyTakeaways ?? []} />
              <List title="What the customer needs" items={session.customerNeeds ?? []} />
              <List title="Concerns raised" items={session.concernsRaised ?? []} />
              <List title="Next steps" items={nextSteps} />
              {summaryPoints.length === 0 && (session.keyTakeaways ?? []).length === 0 && <p className={styles.muted}>The summary isn’t ready yet.</p>}
            </>
          )}
          {tab === 'coaching' && (
            <AiCoachPanel
              sessionId={session._id}
              createdAt={session.createdAt}
              pending={!coaching && stillScoring(session)}
              coaching={coaching}
              onGenerated={(report) => {
                queryClient.setQueryData(['dialer', 'session', sessionId], { ...session, ...report });
                void queryClient.invalidateQueries({ queryKey: ['dialer', 'calls'] });
              }}
            />
          )}
          {tab === 'transcript' &&
            (transcript ? <TranscriptPanel transcript={transcript} isRecording={false} /> : <p className={styles.muted}>No transcript for this call.</p>)}
        </div>
      </main>
    </div>
  );
}
