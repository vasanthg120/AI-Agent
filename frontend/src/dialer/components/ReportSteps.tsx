import type { CallingCall } from '@/services/callingService';
import { FiAlertCircle, FiCheck, FiRefreshCw } from './icons';
import { ActionButton } from './StateScreen';
import styles from './ReportSteps.module.css';

// The recording arrives a little after the call ends; past this, it isn't coming.
const RECORDING_GRACE_MS = 10 * 60_000;

/** After the call: recording → transcript → score, as the report is put together. */
export function ReportSteps({ call, onRetry, retrying, onOpen }: { call: CallingCall; onRetry?: () => void; retrying?: boolean; onOpen: () => void }) {
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
          <p>
            {lost
              ? 'No recording arrived from the phone system for this call.'
              : report?.stage === 'failed'
                ? `${report.error ?? 'The recording couldn’t be transcribed.'} Your recording is saved.`
                : (call.importError ?? 'The recording couldn’t be processed.')}
          </p>
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
