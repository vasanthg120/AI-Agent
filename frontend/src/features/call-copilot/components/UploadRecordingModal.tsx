import { useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiAlertCircle, FiCheck, FiFileText, FiMusic, FiUploadCloud } from 'react-icons/fi';
import { Button, Modal } from '@/components/ui';
import { callCopilotService, type CallSummaryResult, type CoachingReport } from '@/services/callCopilotService';
import { VOICE_LANGUAGES } from '@/services/voiceService';
import { extractErrorMessage } from '@/utils/errors';
import { EASE_OUT, SPRING_SNAPPY } from '../motion';
import { CustomerPicker, type SelectedCustomer } from './CustomerPicker';
import { CallSummaryModal } from './CallSummaryModal';
import styles from './UploadRecordingModal.module.css';

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

// The stages a recording goes through, in order — shown as a stepper so "it's
// working" is a place you can see, not just a spinner.
const STAGES = ['Upload', 'Transcribe', 'Analyze', 'Summarize'] as const;

export interface UploadRecordingModalProps {
  open: boolean;
  onClose: () => void;
  // Called once the upload finishes processing (success or not) so the
  // caller can refresh the Call Library list — never called for a modal
  // the user simply closed before that point.
  onProcessed?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Runs the SAME transcribe -> analyze -> summarize pipeline a live call
// gets, just after the fact on an already-recorded file. Closing this modal
// does NOT stop processing — it continues server-side regardless (see
// CallCopilotUploadService) and the session simply shows up in the Library
// once done; this modal is only a convenience for watching it happen.
export function UploadRecordingModal({ open, onClose, onProcessed }: UploadRecordingModalProps) {
  const languageId = useId();
  const [customer, setCustomer] = useState<SelectedCustomer | null>(null);
  const [language, setLanguage] = useState(VOICE_LANGUAGES[0].code);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [summaryResult, setSummaryResult] = useState<CallSummaryResult | null>(null);
  const [transcript, setTranscript] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [coaching, setCoaching] = useState<CoachingReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const reset = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setCustomer(null);
    setPhase('idle');
    setStage(0);
    setProgressMessage('');
    setError(null);
    setFileInfo(null);
    setSummaryResult(null);
    setTranscript('');
    setSessionId(null);
    setCoaching(null);
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
    setStage(0);
    setError(null);
    setFileInfo({ name: file.name, size: file.size });
    try {
      const { sessionId: newSessionId } = await callCopilotService.uploadRecording(file, {
        dealId: customer?.dealId,
        contactId: undefined,
        languageCode: language,
      });
      setSessionId(newSessionId);
      setPhase('processing');
      setStage(1);
      setProgressMessage('Transcribing your recording…');
      unsubscribeRef.current = callCopilotService.watchUploadProgress(newSessionId, {
        onContextReady: () => setProgressMessage('Gathering customer context…'),
        onTranscript: (_sequence, text) => {
          if (!text) return;
          setStage((s) => Math.max(s, 1));
          setProgressMessage('Transcribing your recording…');
          setTranscript((prev) => (prev ? `${prev} ${text}` : text));
        },
        onAnalysis: () => {
          setStage((s) => Math.max(s, 2));
          setProgressMessage('Analyzing the conversation…');
        },
        onSummary: (result) => {
          setStage(STAGES.length);
          setPhase('done');
          setSummaryResult(result);
          onProcessed?.();
        },
        onCoaching: (result) => setCoaching(result),
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

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFileSelected(file);
  };

  return (
    <>
      <Modal open={open && phase !== 'done'} onClose={handleClose} title="Upload a Recording" maxWidth={560}>
        <div className={styles.body}>
          <p className={styles.lead}>
            Upload a finished call — a Zoom export, a voice memo, a recorded phone call. HaiVE transcribes it, picks out
            the signals and writes the summary, just like a live call.
          </p>

          <CustomerPicker value={customer} onChange={setCustomer} disabled={busy} />

          <div className={styles.field}>
            <label htmlFor={languageId} className={styles.fieldLabel}>
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

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/mp4,.m4a"
            className={styles.fileInput}
            disabled={busy}
            aria-label="Choose a recording"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
            }}
          />

          <>
            {busy ? (
              <motion.div
                key="progress"
                className={styles.progress}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                role="status"
                aria-live="polite"
              >
                {fileInfo && (
                  <div className={styles.file}>
                    <span className={styles.fileIcon} aria-hidden>
                      <FiMusic />
                    </span>
                    <span className={styles.fileText}>
                      <span className={styles.fileName}>{fileInfo.name}</span>
                      <span className={styles.fileSize}>{formatSize(fileInfo.size)}</span>
                    </span>
                  </div>
                )}

                <ol className={styles.stepper}>
                  {STAGES.map((label, index) => {
                    const state = index < stage ? 'done' : index === stage ? 'active' : 'todo';
                    return (
                      <li key={label} className={clsx(styles.stage, styles[state])}>
                        <span className={styles.stageDot}>
                          {state === 'done' ? (
                            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING_SNAPPY}>
                              <FiCheck aria-hidden />
                            </motion.span>
                          ) : (
                            index + 1
                          )}
                        </span>
                        <span className={styles.stageLabel}>{label}</span>
                      </li>
                    );
                  })}
                </ol>

                <p className={styles.message}>
                  {phase === 'uploading' ? 'Uploading your recording…' : progressMessage}
                </p>
                <p className={styles.hint}>You can close this window — processing continues in the background.</p>
              </motion.div>
            ) : (
              <motion.div
                key="drop"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
              >
                <button
                  type="button"
                  className={clsx(styles.drop, dragging && styles.dropActive)}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  <motion.span
                    className={styles.dropIcon}
                    animate={dragging ? { y: -4, scale: 1.08 } : { y: 0, scale: 1 }}
                    transition={SPRING_SNAPPY}
                    aria-hidden
                  >
                    <FiUploadCloud />
                  </motion.span>
                  <span className={styles.dropTitle}>
                    {dragging ? 'Drop it here' : 'Drag a recording here, or click to choose'}
                  </span>
                  <span className={styles.dropHint}>MP3, WAV, M4A, OGG, WebM or MP4 audio</span>
                </button>
              </motion.div>
            )}
          </>

          <AnimatePresence initial={false}>
            {error && (
              <motion.div
                className={styles.errorBox}
                role="alert"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
              >
                <FiAlertCircle aria-hidden />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {phase === 'error' && (
            <div className={styles.actions}>
              <Button type="button" variant="secondary" leftIcon={<FiFileText />} onClick={reset}>
                Try another file
              </Button>
            </div>
          )}
        </div>
      </Modal>

      <CallSummaryModal
        open={open && phase === 'done'}
        onClose={() => {
          handleClose();
          reset();
        }}
        source="upload"
        originalFilename={fileInfo?.name}
        summaryResult={summaryResult}
        transcript={transcript}
        sessionId={sessionId ?? undefined}
        coachingPending={phase === 'done' && !coaching}
        coaching={coaching}
        onCoachingGenerated={setCoaching}
      />
    </>
  );
}
