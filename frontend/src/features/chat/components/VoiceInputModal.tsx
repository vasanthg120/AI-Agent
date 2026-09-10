import { useEffect, useRef, useState } from 'react';
import { FiAlertCircle, FiLoader, FiMic, FiSquare, FiVolume2 } from 'react-icons/fi';
import { Button, Modal } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { useChatStore } from '@/stores/chatStore';
import { voiceService, VOICE_LANGUAGES } from '@/services/voiceService';
import styles from './VoiceInputModal.module.css';

const LANGUAGE_STORAGE_KEY = 'haive-voice-language';

// Same candidate order this app would want on any browser: opus-in-webm is
// what Chrome/Edge/Firefox record natively and is on Sarvam's documented
// supported-format list; mp4/ogg cover Safari and older browsers. An empty
// string falls through to the browser's own MediaRecorder default rather
// than failing outright.
const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_TYPE_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function readStoredLanguage(): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && VOICE_LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    // localStorage can throw in a locked-down browser context — fall back silently.
  }
  return VOICE_LANGUAGES[0].code;
}

type Phase = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking';

// Waits for chatStore's existing streaming lifecycle to finish for this
// specific conversation, then returns the final assistant text — this is
// the ONLY hook point into the existing chat pipeline; nothing about how
// the agent reasons, calls tools, or bills is touched. Voice behaves exactly
// like a normal typed message because it IS one, sent through
// useChatStore.getState().sendMessage — the same function ChatInput.tsx uses.
function waitForAssistantReply(conversationId: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      const state = useChatStore.getState();
      if (state.streamingConversationId === conversationId) return;
      const messages = state.messages[conversationId] ?? [];
      const last = [...messages].reverse().find((m) => m.role === 'assistant');
      if (!last) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      if (last.status === 'complete' && last.content.trim()) resolve(last.content);
      else if (last.status === 'stopped') reject(new Error('Generation was stopped.'));
      else reject(new Error('No response was received.'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new Error('Timed out waiting for a response.'));
    }, timeoutMs);
    const unsub = useChatStore.subscribe(finish);
    finish();
  });
}

export interface VoiceInputModalProps {
  open: boolean;
  onClose: () => void;
}

export function VoiceInputModal({ open, onClose }: VoiceInputModalProps) {
  const [language, setLanguage] = useState(readStoredLanguage);
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState('');
  const [responseText, setResponseText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastAudioBlob, setLastAudioBlob] = useState<Blob | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!open) {
      // Closing mid-flow must never leave a mic hot or audio playing in the background.
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioRef.current?.pause();
      setPhase('idle');
      setTranscript('');
      setResponseText('');
      setError(null);
      setLastAudioBlob(null);
    }
  }, [open]);

  const changeLanguage = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch {
      // Non-fatal — the selection still works for this session.
    }
  };

  const playBlob = (blob: Blob): Promise<void> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Audio playback failed.'));
      };
      audio.play().catch((err: unknown) => {
        URL.revokeObjectURL(url);
        reject(err instanceof Error ? err : new Error('Audio playback failed.'));
      });
    });

  const runVoiceTurn = async (blob: Blob) => {
    if (blob.size === 0) {
      setError('The recording was empty. Please try again.');
      setPhase('idle');
      return;
    }

    setPhase('transcribing');
    try {
      const { transcript: text } = await voiceService.transcribe(blob, language);
      setTranscript(text);

      setPhase('sending');
      const activeAgentId = useChatStore.getState().activeAgentId;
      await useChatStore.getState().sendMessage(text, activeAgentId ?? undefined);
      const conversationId = useChatStore.getState().activeConversationId;
      if (!conversationId) throw new Error('No response was received.');
      const reply = await waitForAssistantReply(conversationId);
      setResponseText(reply);

      setPhase('speaking');
      try {
        const audioBlob = await voiceService.speak(reply, language);
        setLastAudioBlob(audioBlob);
        await playBlob(audioBlob);
      } catch (speakErr) {
        // The text response already landed in the normal chat UI and above
        // — a TTS/playback failure is real but shouldn't erase that.
        setError(extractErrorMessage(speakErr));
      }
      setPhase('idle');
    } catch (err) {
      setError(extractErrorMessage(err));
      setPhase('idle');
    }
  };

  const startRecording = async () => {
    setError(null);
    setTranscript('');
    setResponseText('');
    setLastAudioBlob(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice input is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const finalBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        void runVoiceTurn(finalBlob);
      };
      recorder.start();
      recorderRef.current = recorder;
      setPhase('recording');
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') setError('Microphone permission is required.');
      else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') setError('No microphone was found.');
      else setError('Unable to access the microphone.');
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  };

  const retry = () => {
    setError(null);
    setPhase('idle');
  };

  const replay = () => {
    if (lastAudioBlob) void playBlob(lastAudioBlob).catch((err: unknown) => setError(extractErrorMessage(err)));
  };

  const phaseLabel: Record<Phase, string> = {
    idle: 'Start speaking',
    recording: 'Recording… tap to stop',
    transcribing: 'Recognizing speech…',
    sending: 'Thinking…',
    speaking: 'Speaking…',
  };

  return (
    <Modal open={open} onClose={onClose} title="Haive AI Voice" maxWidth={480}>
      <div className={styles.body}>
        <label className={styles.languageRow}>
          <span className={styles.languageLabel}>Language</span>
          <select
            className={styles.select}
            value={language}
            disabled={phase !== 'idle'}
            onChange={(e) => changeLanguage(e.target.value)}
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.micArea}>
          <button
            type="button"
            className={phase === 'recording' ? styles.micButtonActive : styles.micButton}
            onClick={phase === 'idle' ? () => void startRecording() : phase === 'recording' ? stopRecording : undefined}
            disabled={phase !== 'idle' && phase !== 'recording'}
            aria-label={phase === 'recording' ? 'Stop recording' : 'Start speaking'}
          >
            {phase === 'transcribing' || phase === 'sending' || phase === 'speaking' ? (
              <FiLoader className={styles.spin} size={28} />
            ) : phase === 'recording' ? (
              <FiSquare size={28} />
            ) : (
              <FiMic size={28} />
            )}
          </button>
          <span className={styles.phaseLabel}>{phaseLabel[phase]}</span>
        </div>

        {error && (
          <div className={styles.errorBox} role="alert">
            <FiAlertCircle size={16} />
            <span>{error}</span>
            <Button type="button" variant="ghost" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        )}

        {transcript && (
          <div className={styles.textBlock}>
            <span className={styles.textLabel}>Transcript</span>
            <p className={styles.textValue}>{transcript}</p>
          </div>
        )}

        {responseText && (
          <div className={styles.textBlock}>
            <span className={styles.textLabel}>AI Response</span>
            <p className={styles.textValue}>{responseText}</p>
            {lastAudioBlob && (
              <Button type="button" variant="ghost" size="sm" onClick={replay}>
                <FiVolume2 size={14} /> Play response
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
