import { useRef, useState } from 'react';
import { FiAlertCircle, FiUploadCloud } from 'react-icons/fi';
import { Button, Modal, Spinner } from '@/components/ui';
import { callCopilotService, type CallEvent, type CallSummaryResult } from '@/services/callCopilotService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { CustomerPicker, type SelectedCustomer } from './CustomerPicker';
import { CallSummaryModal } from './CallSummaryModal';
import styles from './UploadRecordingModal.module.css';

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

export interface UploadRecordingModalProps {
  open: boolean;
  onClose: () => void;
  // Called once the upload finishes processing (success or not) so the
  // caller can refresh the Call Library list — never called for a modal
  // the user simply closed before that point.
  onProcessed?: () => void;
}

// Runs the SAME transcribe -> analyze -> summarize pipeline a live call
// gets, just after the fact on an already-recorded file. Closing this modal
// does NOT stop processing — it continues server-side regardless (see
// CallCopilotUploadService) and the session simply shows up in the Library
// once done; this modal is only a convenience for watching it happen.
export function UploadRecordingModal({ open, onClose, onProcessed }: UploadRecordingModalProps) {
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [language, setLanguage] = useState(VOICE_LANGUAGES[0].code);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [summaryResult, setSummaryResult] = useState<CallSummaryResult | null>(null);
  const [transcript, setTranscript] = useState('');
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [sentiment, setSentiment] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const reset = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setCustomer(null);
    setPhase('idle');
    setProgressMessage('');
    setError(null);
    setSummaryResult(null);
    setTranscript('');
    setEvents([]);
    setSentiment(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    // Deliberately does NOT unsubscribe/cancel processing — only tears down
    // this modal's own local UI state.
    onClose();
    if (phase === 'done' || phase === 'error') reset();
  };

  const handleFileSelected = async (file: File) => {
    setPhase('uploading');
    setError(null);
    try {
      const { sessionId } = await callCopilotService.uploadRecording(file, {
        dealId: customer?.dealId,
        contactId: undefined,
        languageCode: language,
      });
      setPhase('processing');
      setProgressMessage('Transcribing your recording…');
      unsubscribeRef.current = callCopilotService.watchUploadProgress(sessionId, {
        onContextReady: () => setProgressMessage('Gathering customer context…'),
        onTranscript: (_sequence, text) => {
          if (!text) return;
          setProgressMessage('Transcribing your recording…');
          setTranscript((prev) => (prev ? `${prev} ${text}` : text));
        },
        onAnalysis: (result) => {
          setProgressMessage('Analyzing the conversation…');
          setSentiment(result.sentiment ?? null);
          setEvents((prev) => [...prev, ...result.events]);
        },
        onSummary: (result) => {
          setPhase('done');
          setSummaryResult(result);
          onProcessed?.();
        },
        onWarning: (message) => setProgressMessage(message),
        onError: (err) => {
          setPhase('error');
          setError(err.message);
        },
      });
    } catch (err) {
      setPhase('error');
      setError(extractErrorMessage(err));
    }
  };

  const busy = phase === 'uploading' || phase === 'processing';

  return (
    <>
      <Modal open={open && phase !== 'done'} onClose={handleClose} title="Upload a Recording" maxWidth={480}>
        <div className={styles.body}>
          <p className={styles.hint}>
            Upload a completed call recording (e.g. a Zoom export or a recorded phone call) — Haive will transcribe it, detect signals, and
            generate a summary, just like a live call.
          </p>

          <CustomerPicker value={customer} onChange={setCustomer} disabled={busy} />

          <label className={styles.languageRow}>
            <span>Language</span>
            <select className={styles.select} value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/mp4,.m4a"
            className={styles.fileInput}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
            }}
          />

          {busy && (
            <div className={styles.progressBox}>
              <Spinner size={16} />
              <span>{progressMessage}</span>
            </div>
          )}

          {error && (
            <div className={styles.errorBox} role="alert">
              <FiAlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {!busy && (
            <Button type="button" leftIcon={<FiUploadCloud />} onClick={() => fileInputRef.current?.click()}>
              Choose a Recording
            </Button>
          )}

          {busy && <p className={styles.hint}>You can close this window — processing continues in the background.</p>}
        </div>
      </Modal>

      <CallSummaryModal
        open={open && phase === 'done'}
        onClose={() => {
          handleClose();
          reset();
        }}
        source="upload"
        summaryResult={summaryResult}
        transcript={transcript}
        events={events}
        sentiment={sentiment}
      />
    </>
  );
}
