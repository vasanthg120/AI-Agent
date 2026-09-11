import { useCallback, useRef, useState } from 'react';

// Same mime-type fallback chain as VoiceInputModal.tsx (opus-in-webm is what
// Chrome/Edge/Firefox record natively and is on Sarvam's supported-format
// list; mp4/ogg cover Safari/older browsers). Kept as its own copy rather
// than importing from VoiceInputModal — this hook re-arms a fresh
// MediaRecorder every SEGMENT_MS instead of running once per modal open, a
// different enough lifecycle that sharing code would mean threading a mode
// flag through the existing, already-shipped voice modal for no real gain,
// against a hard "don't touch working features" requirement.
const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_TYPE_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

// How long each independently-complete audio segment is. Stopping and
// starting a fresh MediaRecorder every cycle (rather than one recorder with
// `timeslice`) is deliberate: with `timeslice`, only the FIRST emitted blob
// in a recording carries a valid container header — later ones are bare
// continuation data that neither Sarvam's batch STT endpoint nor a stored
// GridFS file can play back on their own. A fresh recorder per cycle makes
// every segment a complete, independently valid WebM/Opus file, solving the
// transcription-format problem and the "each stored segment is independently
// playable, no concatenation needed" storage requirement at the same time.
const SEGMENT_MS = 7_000;

export type MicErrorReason = 'unsupported' | 'permission-denied' | 'no-device' | 'unknown';

export interface UseSegmentedRecordingResult {
  isRecording: boolean;
  error: MicErrorReason | null;
  start: () => Promise<MicErrorReason | null>;
  stop: () => void;
}

/** Captures audio in a continuous loop of short, independently-complete
 * segments, invoking onSegment(blob, sequence) once each completes. Mic
 * permission is requested exactly once (on start()) and held across every
 * segment — each cycle only tears down/recreates the MediaRecorder, never
 * the underlying MediaStream, so there's no repeated permission prompt. */
export function useSegmentedRecording(onSegment: (blob: Blob, sequence: number) => void): UseSegmentedRecordingResult {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<MicErrorReason | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sequenceRef = useRef(0);
  const stoppingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armSegment = useCallback((stream: MediaStream) => {
    const mimeType = pickSupportedMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const sequence = sequenceRef.current++;
        onSegment(blob, sequence);
      }
      if (!stoppingRef.current) {
        armSegment(stream);
      }
    };

    recorder.start();
    recorderRef.current = recorder;
    timerRef.current = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, SEGMENT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returns the failure reason directly (rather than only setting state) so
  // a caller can decide NOT to start a call session at all when the mic
  // never actually came up — reading `error` state right after `await
  // start()` would see a stale value from the render that captured this
  // closure, since the setError() call doesn't flush into that same closure.
  const start = useCallback(async (): Promise<MicErrorReason | null> => {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('unsupported');
      return 'unsupported';
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stoppingRef.current = false;
      sequenceRef.current = 0;
      armSegment(stream);
      setIsRecording(true);
      return null;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      const reason: MicErrorReason =
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'permission-denied'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'no-device'
            : 'unknown';
      setError(reason);
      return reason;
    }
  }, [armSegment]);

  const stop = useCallback(() => {
    stoppingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsRecording(false);
  }, []);

  return { isRecording, error, start, stop };
}

export function micErrorMessage(reason: MicErrorReason): string {
  switch (reason) {
    case 'unsupported':
      return 'Voice recording is not supported in this browser.';
    case 'permission-denied':
      return 'Microphone permission is required to start a call.';
    case 'no-device':
      return 'No microphone was found.';
    default:
      return 'Unable to access the microphone.';
  }
}
