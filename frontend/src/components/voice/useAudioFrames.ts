import { useEffect, useRef } from 'react';

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
}

/**
 * A live stream of an audio element's sound, for visualising it without touching what is
 * heard: captureStream() copies the output, so the AI's voice plays exactly as before even if
 * analysis fails. Null where the browser can't (Safari) — callers fall back to an animation.
 */
export function streamOfElement(element: HTMLMediaElement | null): MediaStream | null {
  if (!element) return null;
  const capture = (element as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capture !== 'function') return null;
  try {
    return capture.call(element);
  } catch {
    return null;
  }
}

/**
 * Calls onFrame on every animation frame with the stream's loudness (0–1) and its frequency
 * bins, for drawing straight onto elements through refs — 60 React renders a second for a
 * decoration would cost the whole screen. Nothing runs without a stream.
 */
export function useAudioFrames(stream: MediaStream | null, onFrame: (level: number, bins: Uint8Array) => void, onStop?: () => void) {
  const frameRef = useRef(onFrame);
  const stopRef = useRef(onStop);
  frameRef.current = onFrame;
  stopRef.current = onStop;

  useEffect(() => {
    const Ctor = audioContextCtor();
    if (!stream || !Ctor || stream.getAudioTracks().length === 0) return;
    const context = new Ctor();
    void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    const bins = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      analyser.getByteTimeDomainData(wave);
      let sum = 0;
      for (let i = 0; i < wave.length; i += 1) {
        const x = (wave[i] - 128) / 128;
        sum += x * x;
      }
      // Speech rarely passes an RMS of ~0.3: stretch it so a normal voice fills the range.
      frameRef.current(Math.min(1, Math.sqrt(sum / wave.length) * 3.4), bins);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close().catch(() => undefined);
      stopRef.current?.();
    };
  }, [stream]);
}
