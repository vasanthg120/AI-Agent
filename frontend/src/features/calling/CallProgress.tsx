import { motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAlertCircle, FiCheck, FiX } from 'react-icons/fi';
import { formatInternational, countryOfNumber, PROVIDER_LABEL, type CallingCall } from '@/services/callingService';
import { isCallStale, isImportStuck } from '@/services/plivoService';
import styles from './CallProgress.module.css';
import { Flag } from './Flag';

const STEPS = ['Ringing your phone', 'Talking with the customer', 'Writing the summary', 'Ready in Call Library'];

// Which step a call has reached, or -1 when it stopped before the end.
function stepOf(call: CallingCall): number {
  if (call.importStatus === 'imported') return 3;
  if (call.importStatus === 'failed' || isImportStuck(call)) return -1;
  if (call.status === 'initiated') return 0;
  if (call.status === 'in_progress') return 1;
  if (call.status === 'completed') return 2;
  return -1;
}

// The live journey of the call just placed: each stage lights up as the
// provider reports it, so there's never a moment of "did anything happen?".
export function CallProgress({
  call,
  onOpenLibrary,
  onDismiss,
}: {
  call: CallingCall;
  onOpenLibrary?: () => void;
  onDismiss: () => void;
}) {
  const step = stepOf(call);
  const stopped = step === -1 || isCallStale(call);
  const country = countryOfNumber(call.customerNumber);
  // Where it stopped: the last step it reached before the failure.
  const reached = stopped ? (call.status === 'completed' ? 2 : call.status === 'in_progress' ? 1 : 0) : step;

  return (
    <motion.section
      className={clsx(styles.card, stopped && styles.cardStopped, step === 3 && styles.cardDone)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      aria-live="polite"
      aria-label="Current call"
    >
      <header className={styles.header}>
        <div className={styles.who}>
          <span className={styles.flag} aria-hidden>
            {country ? <Flag iso={country.iso} size="lg" /> : '📞'}
          </span>
          <div>
            <div className={styles.number}>{formatInternational(call.customerNumber)}</div>
            <div className={styles.via}>
              via {PROVIDER_LABEL[call.provider]} · {formatInternational(call.businessNumber)}
            </div>
          </div>
        </div>
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Hide">
          <FiX />
        </button>
      </header>

      <ol className={styles.steps}>
        {STEPS.map((label, i) => {
          const done = i < reached || (!stopped && i === 3 && step === 3);
          const current = !stopped && i === step && step !== 3;
          const failedHere = stopped && i === reached;
          return (
            <li
              key={label}
              className={clsx(styles.step, done && styles.done, current && styles.current, failedHere && styles.failed)}
            >
              <span className={styles.dot} aria-hidden>
                {done ? <FiCheck /> : failedHere ? <FiAlertCircle /> : i + 1}
                {current && (
                  <motion.span
                    className={styles.pulse}
                    animate={{ scale: [1, 1.7], opacity: [0.5, 0] }}
                    transition={{ duration: 1.4, repeat: Infinity }}
                  />
                )}
              </span>
              <span className={styles.stepLabel}>{label}</span>
            </li>
          );
        })}
      </ol>

      {stopped && (
        <p className={styles.reason}>
          {call.importStatus === 'failed'
            ? (call.importError ?? 'The recording could not be processed.')
            : (call.failureReason ?? 'The call ended before it connected.')}
        </p>
      )}
      {step === 3 && onOpenLibrary && (
        <button type="button" className={styles.open} onClick={onOpenLibrary}>
          View summary and AI Coach →
        </button>
      )}
    </motion.section>
  );
}
