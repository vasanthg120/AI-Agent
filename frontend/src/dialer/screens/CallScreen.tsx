import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { callingService, PROVIDER_LABEL, type CallFailure, type CallingCall, type CallingProvider, type CallStage } from '@/services/callingService';
import { extractErrorMessage } from '@/utils/errors';
import { FiAlertCircle, FiArrowLeft, FiCheck, FiPhone, FiPhoneOff, FiRefreshCw } from '../components/icons';
import { ActionButton, StateScreen } from '../components/StateScreen';
import { useDialerAccess } from '../lib/access';
import { formatNumber } from '../lib/dialRules';
import { haptic } from '../lib/haptics';
import { usePlaceCall } from '../lib/placeCall';
import { useWakeLock } from '../lib/useWakeLock';
import styles from './CallScreen.module.css';

type LiveCall = CallingCall & { serverTime?: string };

const LIVE: CallStage[] = ['ringing_agent', 'connecting_customer', 'in_call'];
// The recording arrives a little after the call ends; past this, it isn't coming.
const RECORDING_GRACE_MS = 10 * 60_000;
// Stop asking about a report this long after the call (Recents keeps the rest).
const FOLLOW_REPORT_FOR_MS = 30 * 60_000;

const FAILURE_TITLE: Record<CallFailure, string> = {
  busy: 'Line busy',
  no_answer_customer: 'No answer',
  no_answer_agent: 'You didn’t answer',
  invalid_number: 'Wrong number',
  offline: 'Calling is offline',
  balance: 'Not enough balance',
  cancelled: 'Call cancelled',
  provider_error: 'Call failed',
};

function fallbackStage(status: string): CallStage {
  if (status === 'initiated') return 'ringing_agent';
  if (status === 'in_progress') return 'connecting_customer';
  return status === 'completed' ? 'ended' : 'failed';
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[\p{L}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** After the call: recording → transcript → score, as the report is put together. */
export function ReportSteps({ call, onRetry, retrying, onOpen }: { call: LiveCall; onRetry?: () => void; retrying?: boolean; onOpen: () => void }) {
  const ended = call.outcome?.stage === 'ended';
  if (!ended) return null;
  const report = call.report;
  const lost = call.importStatus === 'none' && Date.now() - new Date(call.updatedAt).getTime() > RECORDING_GRACE_MS;
  const importFailed = call.importStatus === 'failed' || report?.stage === 'failed';
  const steps = [
    {
      label: 'Recording received',
      state: call.importStatus === 'pending' || call.importStatus === 'imported' ? 'done' : importFailed || lost ? 'failed' : 'current',
    },
    {
      label: 'Transcribing',
      state: report && (report.stage === 'scoring' || report.stage === 'ready') ? 'done' : report?.stage === 'failed' ? 'failed' : report || call.importStatus === 'pending' ? 'current' : 'todo',
    },
    { label: 'Scoring', state: report?.stage === 'ready' ? 'done' : report?.stage === 'scoring' ? 'current' : 'todo' },
  ] as const;

  return (
    <section className={styles.steps} aria-label="Your call report">
      <ol>
        {steps.map((step) => (
          <li key={step.label} className={styles[step.state]}>
            <span className={styles.stepDot} aria-hidden>
              {step.state === 'done' ? <FiCheck /> : step.state === 'failed' ? <FiAlertCircle /> : null}
            </span>
            <span>
              {step.label}
              <span className="sr-only">{step.state === 'done' ? ': done' : step.state === 'current' ? ': in progress' : step.state === 'failed' ? ': failed' : ''}</span>
            </span>
          </li>
        ))}
      </ol>
      {report?.stage === 'ready' && (
        <ActionButton onClick={onOpen}>{report.overallScore !== undefined ? `View report · score ${report.overallScore.toFixed(1)}` : 'View report'}</ActionButton>
      )}
      {(importFailed || lost) && (
        <div className={styles.stepNote}>
          <p>{lost ? 'No recording arrived from the phone system for this call.' : (report?.error ?? call.importError ?? 'The recording couldn’t be processed.')}</p>
          {onRetry && !lost && (
            <ActionButton variant="secondary" onClick={onRetry} busy={retrying}>
              <FiRefreshCw /> Try again
            </ActionButton>
          )}
        </div>
      )}
    </section>
  );
}

/** The call being placed, full screen, from "Ringing your phone…" to its report. */
export function CallScreen() {
  const { provider, id } = useParams<{ provider: CallingProvider; id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canPlace } = useDialerAccess();
  const { place, placing } = usePlaceCall();
  const handed = (location.state as { call?: CallingCall } | null)?.call;
  // The server's clock minus this phone's, so the call is timed on the server's.
  const offset = useRef(0);
  const [retrying, setRetrying] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['dialer', 'call', provider, id],
    queryFn: async (): Promise<LiveCall> => {
      const sent = Date.now();
      const call = await callingService.getCall(provider!, id!);
      offset.current = new Date(call.serverTime).getTime() - (sent + Date.now()) / 2;
      return call;
    },
    initialData: handed?.id === id ? handed : undefined,
    initialDataUpdatedAt: 0,
    refetchOnWindowFocus: true,
    retry: 2,
    refetchInterval: (q) => {
      const call = q.state.data;
      if (!call) return 1500;
      const stage = call.outcome?.stage ?? fallbackStage(call.status);
      if (LIVE.includes(stage)) return 1500;
      if (stage === 'failed') return false;
      if (call.report?.stage === 'ready' || call.report?.stage === 'failed' || call.importStatus === 'failed') return false;
      return Date.now() - new Date(call.createdAt).getTime() < FOLLOW_REPORT_FOR_MS ? 4000 : false;
    },
  });
  const call = query.data;
  const stage: CallStage | null = call ? (call.outcome?.stage ?? fallbackStage(call.status)) : null;
  const live = !!stage && LIVE.includes(stage);
  useWakeLock(live);

  // A buzz as the call moves on (not for where it started).
  const previous = useRef<CallStage | null>(null);
  useEffect(() => {
    if (!stage) return;
    if (previous.current && previous.current !== stage) {
      if (stage === 'in_call') haptic('connected');
      else if (stage === 'ended') haptic('ended');
      else if (stage === 'failed') haptic('error');
    }
    if (stage !== previous.current) void queryClient.invalidateQueries({ queryKey: ['dialer', 'calls'] });
    previous.current = stage;
  }, [stage, queryClient]);

  const [, tick] = useState(0);
  useEffect(() => {
    if (stage !== 'in_call') return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  if (query.isError && !call) {
    return (
      <div className={styles.screen}>
        <StateScreen
          icon={<FiAlertCircle />}
          tone="warning"
          title="Couldn’t load this call"
          actions={<ActionButton onClick={() => navigate('/')}>Back to keypad</ActionButton>}
        >
          <p>{extractErrorMessage(query.error)}</p>
        </StateScreen>
      </div>
    );
  }
  if (!call || !stage) {
    return <div className={styles.screen} aria-busy />;
  }

  const name = call.customerName?.trim();
  const number = formatNumber(call.customerNumber);
  const elapsed = stage === 'in_call' && call.answeredAt ? Date.now() + offset.current - new Date(call.answeredAt).getTime() : null;
  const failure = call.outcome?.failure;
  const title =
    stage === 'ringing_agent'
      ? 'Ringing your phone…'
      : stage === 'connecting_customer'
        ? 'Connecting customer…'
        : stage === 'in_call'
          ? elapsed !== null
            ? `In call · ${clock(elapsed)}`
            : 'In call'
          : stage === 'ended'
            ? call.durationSeconds
              ? `Call ended · ${clock(call.durationSeconds * 1000)}`
              : 'Call ended'
            : failure
              ? FAILURE_TITLE[failure]
              : 'Call failed';
  const spoken = stage === 'in_call' ? 'In call' : title;

  const callAgain = async () => {
    setAgainError(null);
    const result = await place({ digits: call.customerNumber, customerName: call.customerName, dealId: call.dealId, replace: true });
    if (!result.ok && result.message) setAgainError(result.message);
  };
  const retry = async () => {
    setRetrying(true);
    try {
      queryClient.setQueryData(['dialer', 'call', provider, id], { ...(await callingService.retryImport(call)), serverTime: new Date().toISOString() });
      await query.refetch();
    } catch (err) {
      setAgainError(extractErrorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`${styles.screen} ${stage === 'failed' ? styles.failedScreen : ''}`}>
      <header className={styles.top}>
        <button type="button" className={styles.back} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} aria-label="Back">
          <FiArrowLeft />
        </button>
        <span className={styles.via}>
          {call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} · {PROVIDER_LABEL[call.provider]} · {formatNumber(call.businessNumber)}
        </span>
      </header>

      <main className={styles.body}>
        <div className={styles.avatarWrap} aria-hidden>
          {live && stage !== 'in_call' && (
            <m.span className={styles.ring} initial={{ scale: 1, opacity: 0.5 }} animate={{ scale: 1.6, opacity: 0 }} transition={{ duration: 1.6, repeat: Infinity }} />
          )}
          <span className={`${styles.avatar} ${stage === 'failed' ? styles.avatarFailed : stage === 'in_call' ? styles.avatarLive : ''}`}>
            {stage === 'failed' ? <FiPhoneOff /> : name && initials(name) ? initials(name) : <FiPhone />}
          </span>
        </div>

        <h1 className={styles.name}>{name || number}</h1>
        {name && <p className={styles.number}>{number}</p>}

        <p className={styles.status} aria-hidden>
          {title}
        </p>
        <p className="sr-only" role="status">
          {spoken}
        </p>

        <p className={styles.detail}>
          {stage === 'ringing_agent' && call.direction === 'outbound' && <>Answer the call from {formatNumber(call.businessNumber)} — that’s HaiVE putting you through.</>}
          {stage === 'connecting_customer' && 'Stay on the line while we ring the customer.'}
          {stage === 'in_call' && 'Hang up on your phone when you’re done. The call is being recorded.'}
          {stage === 'failed' && call.outcome?.message}
        </p>

        <ReportSteps call={call} onRetry={canPlace ? () => void retry() : undefined} retrying={retrying} onOpen={() => navigate(`/report/${call.provider}/${call.id}`)} />
        {againError && (
          <p className={styles.error} role="alert">
            {againError}
          </p>
        )}
      </main>

      {!live && (
        <footer className={styles.actions}>
          {canPlace && call.direction === 'outbound' && (
            <button type="button" className={styles.again} onClick={() => void callAgain()} disabled={placing} aria-busy={placing || undefined}>
              <FiPhone /> {placing ? 'Calling…' : 'Call again'}
            </button>
          )}
          <button type="button" className={styles.finish} onClick={() => navigate('/', { replace: true })}>
            Done
          </button>
        </footer>
      )}
    </div>
  );
}
