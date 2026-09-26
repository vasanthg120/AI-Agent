import { Badge, Button } from '@/components/ui';
import type { BadgeVariant } from '@/components/ui';
import { CALL_STATUS_LABEL, isCallStale, isImportStuck, type PlivoCall } from '@/services/plivoService';
import styles from './CallStatus.module.css';

const STATUS_VARIANT: Record<PlivoCall['status'], BadgeVariant> = {
  initiated: 'info',
  in_progress: 'info',
  completed: 'success',
  no_answer: 'neutral',
  busy: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
};

// How long after a call ends we keep saying "waiting for the recording" — Plivo
// sends it a little after hangup; past this something is more likely wrong than slow.
const RECORDING_GRACE_MS = 10 * 60_000;

// Where one phone call stands, in words: the call itself, then the recording's
// journey into Call Library (transcript, summary, AI Coach). Shared by the
// Settings call log and the Call Copilot page so the two never disagree.
export function CallStatus({
  call,
  onRetry,
  retrying,
  onOpenLibrary,
}: {
  call: PlivoCall;
  onRetry?: (call: PlivoCall) => void;
  retrying?: boolean;
  onOpenLibrary?: () => void;
}) {
  const stale = isCallStale(call);
  const lost = isImportStuck(call);
  const failed = call.importStatus === 'failed' || lost;
  const waitingForRecording =
    call.status === 'completed' &&
    call.importStatus === 'none' &&
    Date.now() - new Date(call.createdAt).getTime() < RECORDING_GRACE_MS;

  return (
    <div className={styles.status}>
      <div className={styles.badges}>
        {stale ? (
          <Badge variant="neutral">No report from Plivo</Badge>
        ) : (
          <Badge variant={STATUS_VARIANT[call.status]}>{CALL_STATUS_LABEL[call.status]}</Badge>
        )}
        {waitingForRecording && <Badge variant="info">Waiting for the recording…</Badge>}
        {call.importStatus === 'pending' && !lost && <Badge variant="info">Processing recording…</Badge>}
        {call.importStatus === 'imported' && <Badge variant="success">In Call Library</Badge>}
        {failed && <Badge variant="danger">Recording not processed</Badge>}
      </div>

      {!stale &&
        call.status !== 'completed' &&
        call.failureReason &&
        call.status !== 'initiated' &&
        call.status !== 'in_progress' && <span className={styles.note}>{call.failureReason}</span>}

      {failed && (
        <div className={styles.note}>
          {lost ? 'Processing was interrupted.' : (call.importError ?? 'The recording could not be imported.')}
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={retrying}
              onClick={() => onRetry(call)}
              className={styles.retry}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {call.importStatus === 'imported' && onOpenLibrary && (
        <button type="button" className={styles.link} onClick={onOpenLibrary}>
          View summary and AI Coach
        </button>
      )}
    </div>
  );
}
