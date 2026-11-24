// Listens for one thing said: tap to start, and it stops by itself once the
// person has finished speaking (a short silence after speech), or when tapped
// again. Returns the recording, or null when nothing was said.

// Same order the chat's voice input uses: what each browser records natively.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

const SPEECH_LEVEL = 0.035; // louder than this is speech
const SILENCE_LEVEL = 0.02; // quieter than this is silence
const SILENCE_AFTER_SPEECH_MS = 1300;
const NOTHING_SAID_MS = 8000;
const MAX_MS = 30000;

export interface Listening {
  // Resolves with what was said (null: nothing, or stopped before speaking).
  result: Promise<Blob | null>;
  // The microphone while it listens (for the window's voice animation).
  stream: MediaStream;
  stop: () => void;
  cancel: () => void;
}

export class MicrophoneError extends Error {}

export async function listen(onLevel?: (level: number) => void): Promise<Listening> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new MicrophoneError('Voice isn’t supported in this browser — type your question instead.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    throw new MicrophoneError(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access is blocked — allow it in the browser’s address bar, or type your question.'
        : 'No microphone was found — type your question instead.',
    );
  }

  const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let heardSpeech = false;
  let cancelled = false;

  const AudioCtx: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const context = AudioCtx ? new AudioCtx() : null;
  const analyser = context?.createAnalyser();
  if (context && analyser) {
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
  }

  const started = Date.now();
  let lastVoice = started;
  let frame = 0;
  const samples = new Float32Array(analyser?.fftSize ?? 0);
  const watch = () => {
    if (recorder.state !== 'recording') return;
    if (analyser) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const level = Math.sqrt(sum / samples.length);
      onLevel?.(level);
      const now = Date.now();
      if (level > SPEECH_LEVEL) {
        heardSpeech = true;
        lastVoice = now;
      } else if (level > SILENCE_LEVEL) lastVoice = now;
      if (heardSpeech && now - lastVoice > SILENCE_AFTER_SPEECH_MS) return recorder.stop();
      if (!heardSpeech && now - started > NOTHING_SAID_MS) return recorder.stop();
    }
    if (Date.now() - started > MAX_MS) return recorder.stop();
    frame = requestAnimationFrame(watch);
  };

  const result = new Promise<Blob | null>((resolve) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => undefined);
      onLevel?.(0);
      // Without a level meter (no Web Audio) we can't tell silence from speech: send what was recorded.
      const spoke = analyser ? heardSpeech : chunks.length > 0;
      resolve(cancelled || !spoke ? null : new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
  });

  recorder.start();
  frame = requestAnimationFrame(watch);
  return {
    result,
    stream,
    stop: () => {
      if (recorder.state === 'recording') recorder.stop();
    },
    cancel: () => {
      cancelled = true;
      if (recorder.state === 'recording') recorder.stop();
    },
  };
}
