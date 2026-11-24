import { readFileSync } from 'fs';
import { join } from 'path';
import { WebmJoinError, joinWebmParts, readWebmPart } from './webm-join';

// Real MediaRecorder parts (Chrome, Opus, recorded the way Call Copilot's live recorder does:
// a fresh recorder per part on one stream — scratchpad rig make-webm-fixtures.js), joined
// into one recording without re-encoding.
const fixture = (i: number) => readFileSync(join(__dirname, 'fixtures', `part-${i}.webm`));
const parts = [0, 1, 2].map(fixture);

/** The same file as a live-mode MediaRecorder writes it: Segment and Cluster of "unknown" size. */
function asLiveMode(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (const id of [Buffer.from([0x18, 0x53, 0x80, 0x67]), Buffer.from([0x1f, 0x43, 0xb6, 0x75])]) {
    for (let at = out.indexOf(id); at >= 0; at = out.indexOf(id, at + 4)) {
      if (out[at + 4] === 0x01) Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(out, at + 4);
    }
  }
  return out;
}

function durationOf(file: Buffer): number | null {
  const at = file.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  return at < 0 ? null : file.readDoubleBE(at + 3);
}

describe('joinWebmParts — one continuous recording from a live call’s parts', () => {
  it('reads each part: its one Opus track and every frame', () => {
    const part = readWebmPart(parts[1]);
    expect(part.codecId).toBe('A_OPUS');
    expect(part.frames.length).toBeGreaterThan(10);
    // About 1.5 s, measured from the frames themselves (not the header's own figure).
    expect(part.durationMs).toBeGreaterThan(1300);
    expect(part.durationMs).toBeLessThan(1700);
  });

  it('joins them into one file: every frame on one timeline, with its real length and where each part starts', () => {
    const read = parts.map((p) => readWebmPart(p));
    const joined = joinWebmParts(parts);
    // Each later part loses only its first frame: the new encoder's warm-up (it would click mid-recording).
    const warmUp = (p: (typeof read)[number]) => p.frames[1].ms - p.frames[0].ms;
    const lengths = read.map((p, i) => (i === 0 ? p.durationMs : p.durationMs - warmUp(p)));
    const expected = lengths.reduce((sum, d) => sum + d, 0);
    expect(joined.durationMs).toBeCloseTo(expected, 3);
    expect(joined.partStartsMs).toEqual([0, lengths[0], lengths[0] + lengths[1]]);
    expect(durationOf(joined.file)).toBeCloseTo(expected, 3);

    const back = readWebmPart(joined.file);
    expect(back.frames).toHaveLength(read.reduce((n, p) => n + p.frames.length, 0) - 2);
    expect(back.frames.every((f, i) => i === 0 || f.ms >= back.frames[i - 1].ms)).toBe(true);
    // The second part's first kept frame lands where the first part ends (to the millisecond).
    expect(back.frames[read[0].frames.length].ms).toBe(Math.round(read[0].durationMs));
    // The audio itself is untouched.
    expect(back.frames[read[0].frames.length].data.equals(read[1].frames[1].data)).toBe(true);
    // Kept whole when asked (no frame left out).
    expect(readWebmPart(joinWebmParts(parts, { primingFrames: 0 }).file).frames).toHaveLength(read.reduce((n, p) => n + p.frames.length, 0));
    // A seek index and a header pointing at it.
    expect(joined.file.includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))).toBe(true);
    expect(joined.file.includes(Buffer.from([0x11, 0x4d, 0x9b, 0x74]))).toBe(true);
  });

  it('reads live-mode parts too (sizes “unknown”, as many browsers write them)', () => {
    const live = parts.map(asLiveMode);
    expect(live[0].equals(parts[0])).toBe(false);
    const a = joinWebmParts(parts);
    const b = joinWebmParts(live);
    expect(b.durationMs).toBeCloseTo(a.durationMs, 6);
    expect(readWebmPart(b.file).frames).toHaveLength(readWebmPart(a.file).frames.length);
  });

  it('a part cut off mid-write keeps the frames it holds; an empty part is passed over', () => {
    const cut = parts[2].subarray(0, Math.floor(parts[2].length * 0.6));
    const kept = readWebmPart(cut);
    expect(kept.frames.length).toBeGreaterThan(0);
    expect(kept.frames.length).toBeLessThan(readWebmPart(parts[2]).frames.length);
    const joined = joinWebmParts([parts[0], cut], { primingFrames: 0 });
    expect(joined.durationMs).toBeCloseTo(readWebmPart(parts[0]).durationMs + kept.durationMs, 3);

    const headerOnly = parts[1].subarray(0, 300); // the header and tracks, no frames yet
    const withEmpty = joinWebmParts([parts[0], headerOnly, parts[2]]);
    expect(withEmpty.partStartsMs[1]).toBe(withEmpty.partStartsMs[2]);
  });

  it('what can’t be joined without re-encoding is said plainly', () => {
    expect(() => joinWebmParts([])).toThrow(WebmJoinError);
    expect(() => joinWebmParts([Buffer.from('ftypM4A not webm')])).toThrow(WebmJoinError);
    expect(() => joinWebmParts([parts[0].subarray(0, 300)])).toThrow('The recording parts hold no audio.');
  });
});
