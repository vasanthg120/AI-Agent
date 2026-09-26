import { useEffect, useRef } from 'react';
import styles from './LevelMeter.module.css';

const BAR_COUNT = 16;

type AudioContextCtor = typeof AudioContext;

// A live audio-level meter for the call's microphone. The bars are moved
// straight through refs on every animation frame — routing 60 updates a second
// through React state would re-render the whole console for a decoration.
// Without a stream (connecting, or a browser with no Web Audio) it settles into
// a slow idle wave instead of sitting dead.
export function LevelMeter({ stream }: { stream: MediaStream | null }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (!stream) return;
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;

    const context = new Ctor();
    void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      // Speech lives in the low-to-mid bins, so sample the bars from there.
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const bin = Math.min(data.length - 1, 1 + Math.floor(i * 2.1));
        const level = data[bin] / 255;
        const bar = bars.current[i];
        if (bar) bar.style.transform = `scaleY(${(0.14 + level * 0.86).toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close().catch(() => undefined);
      bars.current.forEach((bar) => {
        if (bar) bar.style.transform = '';
      });
    };
  }, [stream]);

  return (
    <span className={styles.meter} data-live={stream ? 'true' : 'false'} aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(node) => {
            bars.current[i] = node;
          }}
          className={styles.bar}
          style={{ '--i': i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
