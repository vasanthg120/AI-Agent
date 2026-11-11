import { useId, useState } from 'react';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiRefreshCw } from 'react-icons/fi';
import { Button, Modal } from '@/components/ui';
import { callCopilotService, type CallSessionDetail } from '@/services/callCopilotService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { failureReason } from '../callMeta';
import styles from './FailedCallDialog.module.css';

/** A call whose recording was saved but couldn't be turned into a transcript and
 * summary: why, in words, and a way to run it again from the saved copy. */
export function FailedCallDialog({
  session,
  onClose,
  onRetried,
}: {
  session: CallSessionDetail;
  onClose: () => void;
  onRetried: () => void;
}) {
  const languageId = useId();
  const [busy, setBusy] = useState(false);
  // Calls saved before 2026-11-11 don't know their language; the server won't guess.
  const [language, setLanguage] = useState(
    VOICE_LANGUAGES.find((l) => l.code === 'en')?.code ?? VOICE_LANGUAGES[0].code,
  );
  const canRetry = session.source === 'upload' && !!session.originalRecordingFileId;
  const needsLanguage = canRetry && !session.languageCode;

  const retry = async () => {
    setBusy(true);
    try {
      await callCopilotService.retrySession(session._id, needsLanguage ? language : undefined);
      toast.success('Processing this call again. The summary appears here in a few minutes.');
      onRetried();
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="This call couldn’t be processed" maxWidth={520}>
      <div className={styles.body}>
        <p className={styles.reason} role="alert">
          <FiAlertCircle aria-hidden className={styles.icon} />
          <span>{failureReason(session.errorMessage)}</span>
        </p>

        {canRetry ? (
          <p className={styles.note}>
            Your recording is saved, so nothing is lost. Fix the problem above if there is one, then try again.
          </p>
        ) : (
          <p className={styles.note}>There’s no saved recording for this call, so it can’t be processed again.</p>
        )}

        {needsLanguage && (
          <div className={styles.field}>
            <label htmlFor={languageId} className={styles.label}>
              Spoken language
            </label>
            <select
              id={languageId}
              className={styles.select}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={busy}
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {canRetry && (
            <Button type="button" leftIcon={<FiRefreshCw />} loading={busy} onClick={() => void retry()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
