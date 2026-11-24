// Joins a live call's recording parts into ONE continuous WebM file — without decoding or
// re-encoding (no ffmpeg on the servers). A live call is recorded as a chain of short parts,
// each a complete WebM made by its own MediaRecorder (see useSegmentedRecording: each part
// must be transcribable on its own). Their audio frames are copied as they are into a single
// new WebM: one header and track, every frame re-timed onto one timeline, regrouped into
// clusters, with an exact Duration and a Cues index so a browser can show the length and
// seek anywhere. Parts written by any browser's MediaRecorder are read: sizes known or
// "unknown" (live mode), SimpleBlocks or BlockGroups, a cut-off last part (the call ended
// mid-write) — whatever complete frames it holds are kept.

export class WebmJoinError extends Error {}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

// What can follow a Cluster inside the Segment — the end of a cluster whose size is "unknown".
const SEGMENT_CHILDREN = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, 0x1254c367, 0x1043a770, 0x1941a469]);

// A new cluster at least this often (a cluster's frames are timed relative to it, in 16 bits).
const CLUSTER_MS = 5_000;
const DEFAULT_FRAME_MS = 20;
// Frames left out at the start of each part after the first (see joinWebmParts).
const PRIMING_FRAMES = 1;

interface Element {
  id: number;
  start: number;
  dataStart: number;
  // Where its data ends: the buffer's end for an "unknown" size (the caller decides where it really stops).
  dataEnd: number;
  unknownSize: boolean;
}

/** One audio frame, as found in a part. */
export interface WebmFrame {
  // When it starts in its part, in milliseconds.
  ms: number;
  // The block's own bytes after its timecode: [flags][frame data, lacing included].
  flags: number;
  data: Buffer;
  // The track number, exactly as it was written (a variable-length integer).
  track: Buffer;
}

export interface WebmPart {
  // The EBML header element, whole.
  header: Buffer;
  // The Tracks element, whole.
  tracks: Buffer;
  codecId: string;
  frames: WebmFrame[];
  // How long its audio runs: from the first frame's start to the last frame's end.
  durationMs: number;
}

export interface JoinedRecording {
  file: Buffer;
  durationMs: number;
  // Where each input part starts in the joined recording, in milliseconds (same order as the input).
  partStartsMs: number[];
  mimeType: 'audio/webm';
}

// ---- reading ----------------------------------------------------------------------------

function readId(buf: Buffer, pos: number): { id: number; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && !(first & mask)) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + buf[pos + i];
  return { id, length };
}

function readVint(buf: Buffer, pos: number): { value: number; length: number; unknown: boolean } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function readElement(buf: Buffer, pos: number): Element | null {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readVint(buf, pos + id.length);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return { id: id.id, start: pos, dataStart, dataEnd: size.unknown ? buf.length : dataStart + size.value, unknownSize: size.unknown };
}

function readUint(buf: Buffer, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i += 1) value = value * 256 + buf[i];
  return value;
}

function median(values: number[]): number {
  if (values.length === 0) return DEFAULT_FRAME_MS;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Reads one part: its header, its one audio track, and every complete frame. */
export function readWebmPart(buf: Buffer): WebmPart {
  const ebml = readElement(buf, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.dataEnd > buf.length) throw new WebmJoinError('Not a WebM file.');
  const segment = readElement(buf, ebml.dataEnd);
  if (!segment || segment.id !== ID.Segment) throw new WebmJoinError('No WebM segment.');
  const segmentEnd = Math.min(segment.dataEnd, buf.length);

  let timecodeScale = 1_000_000;
  let tracks: Buffer | null = null;
  let codecId = '';
  let trackCount = 0;
  const frames: WebmFrame[] = [];

  const addBlock = (start: number, end: number, clusterTimecode: number) => {
    const track = readVint(buf, start);
    if (!track || start + track.length + 3 > end) return;
    const relative = buf.readInt16BE(start + track.length);
    const flags = buf[start + track.length + 2];
    frames.push({
      ms: ((clusterTimecode + relative) * timecodeScale) / 1_000_000,
      flags,
      data: buf.subarray(start + track.length + 3, end),
      track: buf.subarray(start, start + track.length),
    });
  };

  let pos = segment.dataStart;
  parsing: while (pos < segmentEnd) {
    const el = readElement(buf, pos);
    if (!el) break;
    if (el.id === ID.Cluster) {
      const clusterLimit = Math.min(el.dataEnd, segmentEnd);
      let timecode = 0;
      let p = el.dataStart;
      while (p < clusterLimit) {
        const child = readElement(buf, p);
        if (!child) break parsing;
        // A cluster of "unknown" size ends where the next segment-level element begins.
        if (el.unknownSize && SEGMENT_CHILDREN.has(child.id)) break;
        // Cut off mid-element: the part ended here (the frames before it are kept).
        if (child.dataEnd > buf.length || child.unknownSize) break parsing;
        if (child.id === ID.Timecode) timecode = readUint(buf, child.dataStart, child.dataEnd);
        else if (child.id === ID.SimpleBlock) addBlock(child.dataStart, child.dataEnd, timecode);
        else if (child.id === ID.BlockGroup) {
          for (let q = child.dataStart; q < child.dataEnd; ) {
            const inner = readElement(buf, q);
            if (!inner || inner.dataEnd > child.dataEnd) break;
            if (inner.id === ID.Block) addBlock(inner.dataStart, inner.dataEnd, timecode);
            q = inner.dataEnd;
          }
        }
        p = child.dataEnd;
      }
      pos = el.unknownSize ? p : el.dataEnd;
      continue;
    }
    if (el.unknownSize || el.dataEnd > buf.length) break;
    if (el.id === ID.Info) {
      for (let q = el.dataStart; q < el.dataEnd; ) {
        const child = readElement(buf, q);
        if (!child) break;
        if (child.id === ID.TimecodeScale) timecodeScale = readUint(buf, child.dataStart, child.dataEnd) || 1_000_000;
        q = child.dataEnd;
      }
    } else if (el.id === ID.Tracks) {
      tracks = buf.subarray(el.start, el.dataEnd);
      for (let q = el.dataStart; q < el.dataEnd; ) {
        const entry = readElement(buf, q);
        if (!entry) break;
        if (entry.id === ID.TrackEntry) {
          trackCount += 1;
          for (let r = entry.dataStart; r < entry.dataEnd; ) {
            const field = readElement(buf, r);
            if (!field) break;
            if (field.id === ID.CodecID) codecId = buf.subarray(field.dataStart, field.dataEnd).toString('latin1');
            r = field.dataEnd;
          }
        }
        q = entry.dataEnd;
      }
    }
    pos = el.dataEnd;
  }

  if (!tracks) throw new WebmJoinError('The WebM file has no track.');
  if (trackCount !== 1) throw new WebmJoinError('Only a single-track recording can be joined.');
  frames.sort((a, b) => a.ms - b.ms);
  const gaps = frames.slice(1).map((f, i) => f.ms - frames[i].ms).filter((d) => d > 0);
  const frameMs = median(gaps);
  const durationMs = frames.length ? frames[frames.length - 1].ms - frames[0].ms + frameMs : 0;
  return { header: buf.subarray(0, ebml.dataEnd), tracks, codecId, frames, durationMs };
}

// ---- writing ----------------------------------------------------------------------------

function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from(bytes);
}

function sizeBytes(size: number): Buffer {
  let length = 1;
  // 2^(7·length) − 1 is reserved for "unknown".
  while (size >= 2 ** (7 * length) - 1) length += 1;
  if (length > 8) throw new WebmJoinError('Element too large.');
  const out = Buffer.alloc(length);
  let v = size;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function element(id: number, ...payload: Buffer[]): Buffer {
  const data = Buffer.concat(payload);
  return Buffer.concat([idBytes(id), sizeBytes(data.length), data]);
}

function uintElement(id: number, value: number, fixedLength?: number): Buffer {
  const bytes: number[] = [];
  for (let v = Math.max(0, Math.round(value)); v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  while (bytes.length < (fixedLength ?? 1)) bytes.unshift(0);
  return element(id, Buffer.from(bytes));
}

function floatElement(id: number, value: number): Buffer {
  const data = Buffer.alloc(8);
  data.writeDoubleBE(value);
  return element(id, data);
}

/**
 * The parts, in order, as one recording. Parts with no audio in them are passed over (their
 * start is where the next one starts). Throws WebmJoinError when the parts can't be joined
 * without re-encoding — not WebM (Safari records MP4), or not the same codec.
 */
export function joinWebmParts(buffers: Buffer[], options: { primingFrames?: number } = {}): JoinedRecording {
  const primingFrames = options.primingFrames ?? PRIMING_FRAMES;
  if (buffers.length === 0) throw new WebmJoinError('No recording parts.');
  const parts = buffers.map((b) => readWebmPart(b));
  const withAudio = parts.filter((p) => p.frames.length > 0);
  if (withAudio.length === 0) throw new WebmJoinError('The recording parts hold no audio.');
  const codec = withAudio[0].codecId;
  if (withAudio.some((p) => p.codecId !== codec)) throw new WebmJoinError('The recording parts use different codecs.');

  // One timeline: each part follows the one before, its frames shifted by where it starts.
  const partStartsMs: number[] = [];
  const timeline: { ms: number; frame: WebmFrame }[] = [];
  let offset = 0;
  let joinedSoFar = 0;
  for (const part of parts) {
    partStartsMs.push(offset);
    if (part.frames.length === 0) continue;
    // Every part after the first starts with a fresh encoder: its first frame(s) are the encoder
    // warming up, which a player drops at the start of a file but would play mid-recording as a
    // click. They are left out (a few hundredths of a second, mostly silence).
    const skip = joinedSoFar > 0 ? Math.min(primingFrames, part.frames.length - 1) : 0;
    const kept = part.frames.slice(skip);
    const first = kept[0].ms;
    for (const frame of kept) timeline.push({ ms: offset + frame.ms - first, frame });
    offset += part.durationMs - (first - part.frames[0].ms);
    joinedSoFar += 1;
  }
  const durationMs = offset;

  // Clusters of up to CLUSTER_MS, each frame timed relative to its cluster.
  const clusters: { timecode: number; bytes: Buffer }[] = [];
  let current: { timecode: number; blocks: Buffer[] } | null = null;
  const flush = () => {
    if (current) clusters.push({ timecode: current.timecode, bytes: element(ID.Cluster, uintElement(ID.Timecode, current.timecode), ...current.blocks) });
  };
  for (const { ms, frame } of timeline) {
    const at = Math.round(ms);
    if (!current || at - current.timecode >= CLUSTER_MS) {
      flush();
      current = { timecode: at, blocks: [] };
    }
    const relative = Buffer.alloc(2);
    relative.writeInt16BE(at - current.timecode);
    // Audio frames are all keyframes; the lacing bits are kept as they were.
    current.blocks.push(element(ID.SimpleBlock, frame.track, relative, Buffer.from([(frame.flags & 0x06) | 0x80]), frame.data));
  }
  flush();

  const info = element(
    ID.Info,
    uintElement(ID.TimecodeScale, 1_000_000),
    floatElement(ID.Duration, durationMs),
    element(ID.MuxingApp, Buffer.from('HaiVE')),
    element(ID.WritingApp, Buffer.from('HaiVE call recording')),
  );
  const tracks = withAudio[0].tracks;
  const trackNumber = readVint(withAudio[0].frames[0].track, 0)?.value ?? 1;

  // Positions are counted from the start of the Segment's data. The SeekHead's own size is
  // fixed (8-byte positions), so the layout can be worked out before it is written.
  const seekHead = (infoAt: number, tracksAt: number, cuesAt: number) =>
    element(
      ID.SeekHead,
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Info)), uintElement(ID.SeekPosition, infoAt, 8)),
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Tracks)), uintElement(ID.SeekPosition, tracksAt, 8)),
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Cues)), uintElement(ID.SeekPosition, cuesAt, 8)),
    );
  const headLength = seekHead(0, 0, 0).length;
  const infoAt = headLength;
  const tracksAt = infoAt + info.length;
  let at = tracksAt + tracks.length;
  const cuePoints: Buffer[] = [];
  for (const cluster of clusters) {
    cuePoints.push(
      element(ID.CuePoint, uintElement(ID.CueTime, cluster.timecode), element(ID.CueTrackPositions, uintElement(ID.CueTrack, trackNumber), uintElement(ID.CueClusterPosition, at))),
    );
    at += cluster.bytes.length;
  }
  const cues = element(ID.Cues, ...cuePoints);
  const segment = element(ID.Segment, seekHead(infoAt, tracksAt, at), info, tracks, ...clusters.map((c) => c.bytes), cues);
  return { file: Buffer.concat([withAudio[0].header, segment]), durationMs, partStartsMs, mimeType: 'audio/webm' };
}
