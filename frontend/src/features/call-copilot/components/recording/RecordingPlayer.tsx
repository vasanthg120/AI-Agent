import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiDownload, FiPause, FiPlay, FiRefreshCw, FiRotateCcw, FiRotateCw } from 'react-icons/fi';
import { callCopilotService, type CallRecordingInfo } from '@/services/callCopilotService';
import { PEAK_COUNT, joinShapes, placeholderPeaks, shapeOf, type DecodedShape } from './peaks';
import styles from './RecordingPlayer.module.css';

export interface RecordingPlayerHandle {
  /** Jumps to a moment of the call (and plays, unless told not to). */
  seek: (seconds: number, play?: boolean) => void;
}

export interface RecordingPlayerProps {
  sessionId: string;
  // The parts to fall back on if the server can't say what the recording is.
  fallbackParts?: string[];
  // While playing (about four times a second) and on every jump: where the call is.
  onTime?: (seconds: number) => void;
  // Once known: what the recording is, and where each transcript line starts.
  onInfo?: (info: CallRecordingInfo) => void;
  downloadName?: string;
}

interface Source {
  url: string;
  // Where it starts in the call, and how long it is (seconds).
  start: number;
  duration: number;
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const BAR_WIDTH = 3;
const BAR_GAP = 2;

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

/** A recording made by MediaRecorder may not say how long it is: make the browser work it out. */
function settleDuration(audio: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(audio.duration)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener('durationchange', onChange);
      audio.currentTime = 0;
      resolve();
    };
    const onChange = () => Number.isFinite(audio.duration) && done();
    audio.addEventListener('durationchange', onChange);
    audio.currentTime = 1e101;
    setTimeout(done, 4000);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// The call's recording, whole: one timeline for the entire call however it was captured (a
// live call's parts are joined on the server; an upload or phone call is its original file),
// its real length, a waveform drawn from the audio itself that fills as it plays, seeking by
// click, drag or keyboard, ±10 seconds, speed, and download. Progress moves through refs
// every frame; React only hears about it a few times a second (for the transcript).
export const RecordingPlayer = forwardRef<RecordingPlayerHandle, RecordingPlayerProps>(function RecordingPlayer(
  { sessionId, fallbackParts, onTime, onInfo, downloadName },
  ref,
) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [info, setInfo] = useState<CallRecordingInfo | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [shape, setShape] = useState<DecodedShape | null>(null);
  const [shapePending, setShapePending] = useState(true);
  const [duration, setDuration] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [barCount, setBarCount] = useState(120);
  const [hover, setHover] = useState<{ x: number; seconds: number } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const pendingSeek = useRef<{ offset: number; play: boolean } | null>(null);
  const dragging = useRef(false);
  const lastReport = useRef(0);
  const onTimeRef = useRef(onTime);
  const onInfoRef = useRef(onInfo);
  onTimeRef.current = onTime;
  onInfoRef.current = onInfo;

  // ---- loading: what the recording is, its audio, and its shape ----
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    setPhase('loading');
    setShape(null);
    setShapePending(true);
    setSources([]);
    setIndex(0);
    setPlaying(false);
    setTime(0);
    (async () => {
      let recording: CallRecordingInfo;
      try {
        recording = await callCopilotService.getRecording(sessionId);
      } catch {
        if (!fallbackParts?.length) throw new Error('no recording');
        recording = { kind: 'parts', fileId: null, mimeType: 'audio/webm', durationSeconds: null, segmentStarts: {}, parts: fallbackParts };
      }
      if (cancelled) return;
      setInfo(recording);
      onInfoRef.current?.(recording);
      if (recording.kind === 'none') {
        setPhase('empty');
        return;
      }
      if (recording.fileId) {
        const blob = await callCopilotService.getAudioBlob(sessionId, recording.fileId);
        if (cancelled) return;
        const url = URL.createObjectURL(recording.mimeType ? new Blob([blob], { type: recording.mimeType }) : blob);
        urls.push(url);
        setSources([{ url, start: 0, duration: recording.durationSeconds ?? 0 }]);
        setDuration(recording.durationSeconds ?? 0);
        setPhase('ready');
        const decoded = await shapeOf(blob);
        if (cancelled) return;
        setShape(decoded);
        setShapePending(false);
        if (decoded && !recording.durationSeconds) {
          setDuration(decoded.durationSeconds);
          setSources([{ url, start: 0, duration: decoded.durationSeconds }]);
        }
        return;
      }
      // Parts that couldn't be joined: one timeline over all of them (each measured by decoding it).
      const blobs = await mapLimit(recording.parts, 6, (id) => callCopilotService.getAudioBlob(sessionId, id));
      if (cancelled) return;
      const shapes = await mapLimit(blobs, 3, (b) => shapeOf(b));
      if (cancelled) return;
      let start = 0;
      const list: Source[] = blobs.map((blob, i) => {
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const length = shapes[i]?.durationSeconds ?? 7;
        const source = { url, start, duration: length };
        start += length;
        return source;
      });
      setSources(list);
      setDuration(start);
      setShape(joinShapes(shapes.map((s, i) => s ?? { peaks: placeholderPeaks(24), durationSeconds: list[i].duration })));
      setShapePending(false);
      setPhase('ready');
    })().catch(() => {
      if (!cancelled) setPhase('error');
    });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // fallbackParts is only consulted on a failure; a new list doesn't reload the audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt]);

  // ---- the waveform's width decides how many bars it has ----
  useEffect(() => {
    const el = waveRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setBarCount(Math.max(24, Math.floor(entry.contentRect.width / (BAR_WIDTH + BAR_GAP))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [phase]);

  const bars = useMemo(() => {
    const peaks = shape?.peaks ?? placeholderPeaks(PEAK_COUNT);
    const out: number[] = [];
    for (let i = 0; i < barCount; i += 1) {
      const from = Math.floor((i / barCount) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / barCount) * peaks.length));
      let max = 0;
      for (let p = from; p < to; p += 1) max = Math.max(max, peaks[p] ?? 0);
      out.push(Math.max(0.06, max));
    }
    return out;
  }, [shape, barCount]);

  // ---- where the call is ----
  const globalTime = useCallback(() => {
    const audio = audioRef.current;
    const source = sources[index];
    if (!audio || !source) return 0;
    return source.start + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  }, [sources, index]);

  const paint = useCallback(
    (seconds: number) => {
      const progress = duration > 0 ? Math.min(1, Math.max(0, seconds / duration)) : 0;
      waveRef.current?.style.setProperty('--progress', String(progress));
      if (clockRef.current) clockRef.current.textContent = clock(seconds);
    },
    [duration],
  );

  const report = useCallback((seconds: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastReport.current < 250) return;
    lastReport.current = now;
    setTime(seconds);
    onTimeRef.current?.(seconds);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const t = globalTime();
      if (!dragging.current) paint(t);
      report(t);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, globalTime, paint, report]);

  useEffect(() => paint(time), [duration]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- playing and jumping ----
  const seek = useCallback(
    (seconds: number, play?: boolean) => {
      const audio = audioRef.current;
      if (!audio || sources.length === 0) return;
      const target = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.05));
      const at = sources.findIndex((s, i) => target < s.start + s.duration || i === sources.length - 1);
      const keepPlaying = play ?? !audio.paused;
      paint(target);
      report(target, true);
      if (at !== index) {
        pendingSeek.current = { offset: target - sources[at].start, play: keepPlaying };
        setIndex(at);
        return;
      }
      audio.currentTime = target - sources[at].start;
      if (keepPlaying) void audio.play().catch(() => setPlaying(false));
    },
    [sources, duration, index, paint, report],
  );

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (duration > 0 && globalTime() >= duration - 0.1) seek(0, true);
      else void audio.play().catch(() => setPlaying(false));
    } else audio.pause();
  };

  const onLoaded = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
    await settleDuration(audio);
    // A single file whose length the server didn't know: the browser's own measure.
    if (sources.length === 1 && !duration && Number.isFinite(audio.duration)) {
      setDuration(audio.duration);
      setSources([{ ...sources[0], duration: audio.duration }]);
    }
    const pending = pendingSeek.current;
    if (pending) {
      pendingSeek.current = null;
      audio.currentTime = pending.offset;
      if (pending.play) void audio.play().catch(() => setPlaying(false));
    }
  };

  const onEnded = () => {
    if (index < sources.length - 1) {
      // The next part follows straight on.
      pendingSeek.current = { offset: 0, play: true };
      setIndex(index + 1);
      return;
    }
    setPlaying(false);
    paint(duration);
    report(duration, true);
  };

  const changeSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  // ---- the waveform as a slider ----
  const secondsAt = (clientX: number) => {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return (Math.min(Math.max(0, clientX - rect.left), rect.width) / rect.width) * duration;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    paint(secondsAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = waveRef.current?.getBoundingClientRect();
    if (rect) setHover({ x: Math.min(Math.max(0, e.clientX - rect.left), rect.width), seconds: secondsAt(e.clientX) });
    if (dragging.current) paint(secondsAt(e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    seek(secondsAt(e.clientX));
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key as 'ArrowLeft'];
    if (step !== undefined) {
      e.preventDefault();
      seek(globalTime() + step);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      seek(e.key === 'Home' ? 0 : duration);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  };

  if (phase === 'error') {
    return (
      <div className={clsx(styles.player, styles.message)} role="alert">
        The recording couldn’t be loaded.
        <button type="button" className={styles.retry} onClick={() => setAttempt((a) => a + 1)}>
          <FiRefreshCw aria-hidden /> Try again
        </button>
      </div>
    );
  }
  if (phase === 'empty') return <div className={clsx(styles.player, styles.message)}>Nothing was recorded for this call.</div>;

  const ready = phase === 'ready';
  const source = sources[index];
  const single = sources.length === 1 ? sources[0] : null;
  const extension = info?.mimeType?.includes('mpeg') ? 'mp3' : (info?.mimeType?.split('/')[1]?.split(';')[0] ?? 'webm');

  return (
    <div className={styles.player} data-playing={playing ? 'true' : 'false'}>
      {source && (
        <audio
          ref={audioRef}
          src={source.url}
          preload="auto"
          onLoadedMetadata={() => void onLoaded()}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={onEnded}
          className={styles.hiddenAudio}
        />
      )}

      <button
        type="button"
        className={styles.play}
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? 'Pause the recording' : 'Play the recording'}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={playing ? 'pause' : 'play'}
            className={styles.playIcon}
            initial={{ scale: 0.4, opacity: 0, rotate: -45 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.4, opacity: 0, rotate: 45 }}
            transition={{ duration: 0.16 }}
          >
            {playing ? <FiPause /> : <FiPlay />}
          </motion.span>
        </AnimatePresence>
      </button>

      <div className={styles.body}>
        <div
          ref={waveRef}
          className={clsx(styles.wave, shapePending && styles.wavePending)}
          role="slider"
          tabIndex={ready ? 0 : -1}
          aria-label="Position in the recording"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
        >
          <span className={styles.bars} aria-hidden>
            {bars.map((h, i) => (
              <span key={i} className={styles.bar} style={{ height: `${Math.round(h * 100)}%`, '--i': i } as React.CSSProperties} />
            ))}
          </span>
          <span className={clsx(styles.bars, styles.barsPlayed)} aria-hidden>
            {bars.map((h, i) => (
              <span key={i} className={styles.bar} style={{ height: `${Math.round(h * 100)}%`, '--i': i } as React.CSSProperties} />
            ))}
          </span>
          <span className={styles.playhead} aria-hidden />
          {hover && duration > 0 && (
            <span className={styles.hoverTime} style={{ left: hover.x }} aria-hidden>
              {clock(hover.seconds)}
            </span>
          )}
        </div>

        <div className={styles.controls}>
          <span className={styles.time}>
            <span ref={clockRef}>{clock(time)}</span>
            <span className={styles.timeTotal}> / {duration ? clock(duration) : '–:––'}</span>
            {playing && (
              <span className={styles.eq} aria-hidden>
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          <span className={styles.buttons}>
            <button type="button" className={styles.small} onClick={() => seek(globalTime() - 10)} disabled={!ready} aria-label="Back 10 seconds" title="Back 10 seconds">
              <FiRotateCcw aria-hidden />
              <span>10</span>
            </button>
            <button type="button" className={styles.small} onClick={() => seek(globalTime() + 10)} disabled={!ready} aria-label="Forward 10 seconds" title="Forward 10 seconds">
              <FiRotateCw aria-hidden />
              <span>10</span>
            </button>
            <button type="button" className={clsx(styles.small, styles.speed)} onClick={changeSpeed} disabled={!ready} aria-label={`Playback speed ${speed}×`} title="Playback speed">
              {speed}×
            </button>
            {single && (
              <a className={styles.small} href={single.url} download={`${downloadName ?? 'call-recording'}.${extension}`} aria-label="Download the recording" title="Download">
                <FiDownload aria-hidden />
              </a>
            )}
          </span>
        </div>
        {info?.note && <span className={styles.note}>{info.note}</span>}
      </div>
    </div>
  );
});
