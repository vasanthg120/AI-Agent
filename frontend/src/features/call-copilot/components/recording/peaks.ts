// The shape of a recording's sound, for drawing its waveform: decoded once in the browser at a
// low sample rate (enough for a picture, a fraction of the memory), then reduced to peaks.

type OfflineCtor = typeof OfflineAudioContext;

// Larger recordings are drawn as a plain bar (decoding them would cost too much memory).
const MAX_DECODE_BYTES = 80 * 1024 * 1024;
export const PEAK_COUNT = 720;

export interface DecodedShape {
  // 0–1, PEAK_COUNT values across the whole recording.
  peaks: number[];
  durationSeconds: number;
}

function offlineCtor(): OfflineCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
}

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('No Web Audio');
  // 8 kHz is plenty for a picture of speech; some browsers only allow 22.05 kHz and up.
  for (const rate of [8000, 22050]) {
    try {
      return await new Ctor(1, 1, rate).decodeAudioData(data.slice(0));
    } catch (err) {
      if (rate === 22050) throw err;
    }
  }
  throw new Error('Not decodable');
}

/** Peaks of the loudest sound in each slice, all channels mixed. */
export function peaksOf(buffer: AudioBuffer, count = PEAK_COUNT): number[] {
  const length = buffer.length;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const peaks = new Array<number>(count).fill(0);
  const step = length / count;
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.min(length, Math.max(from + 1, Math.floor((i + 1) * step)));
    let max = 0;
    // Every sample is overkill for a picture: stride through long slices.
    const stride = Math.max(1, Math.floor((to - from) / 400));
    for (let s = from; s < to; s += stride) {
      for (const data of channels) {
        const v = Math.abs(data[s]);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
  }
  return normalise(peaks);
}

function normalise(peaks: number[]): number[] {
  const loudest = Math.max(...peaks, 1e-6);
  // A gentle curve, so quiet speech still shows.
  return peaks.map((p) => Math.min(1, Math.pow(p / loudest, 0.7)));
}

/** One file's shape. Null when it can't be drawn (too large, or the browser can't decode it). */
export async function shapeOf(blob: Blob): Promise<DecodedShape | null> {
  if (blob.size > MAX_DECODE_BYTES) return null;
  try {
    const buffer = await decode(await blob.arrayBuffer());
    return { peaks: peaksOf(buffer), durationSeconds: buffer.duration };
  } catch {
    return null;
  }
}

/** Several files played as one: their shapes side by side, each as wide as it is long. */
export function joinShapes(shapes: DecodedShape[], count = PEAK_COUNT): DecodedShape {
  const total = shapes.reduce((sum, s) => sum + s.durationSeconds, 0) || 1;
  const peaks: number[] = [];
  for (const s of shapes) {
    const share = Math.max(1, Math.round((s.durationSeconds / total) * count));
    for (let i = 0; i < share; i += 1) peaks.push(s.peaks[Math.min(s.peaks.length - 1, Math.floor((i / share) * s.peaks.length))] ?? 0);
  }
  return { peaks: normalise(peaks), durationSeconds: total };
}

/** A flat, gently varied line for a recording that can't be decoded — the player still works. */
export function placeholderPeaks(count = PEAK_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => 0.25 + 0.12 * Math.sin(i / 7) + 0.08 * Math.sin(i / 2.3));
}
