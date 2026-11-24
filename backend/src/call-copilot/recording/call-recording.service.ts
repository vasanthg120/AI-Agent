import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GridFsService } from '../../common/gridfs/gridfs.service';
import { CallSession, CallSessionDocument } from '../schemas/call-session.schema';
import { WebmJoinError, joinWebmParts } from './webm-join';

const AUDIO_BUCKET = 'call_recordings';

/** What a call's recording is, for the player. */
export interface CallRecordingInfo {
  // original: the uploaded or phone-call file as it came; joined: a live call's parts as one
  // recording; parts: a live call whose parts can't be joined (played one after another);
  // none: nothing was recorded.
  kind: 'original' | 'joined' | 'parts' | 'none';
  // The one file to play (original or joined).
  fileId: string | null;
  mimeType: string | null;
  // Known exactly for a joined recording; for an original, the player measures it.
  durationSeconds: number | null;
  // Where each transcript segment starts in the recording, in seconds, by sequence — for
  // following along in the transcript and jumping to a line.
  segmentStarts: Record<string, number>;
  // kind 'parts': the files in order.
  parts: string[];
  // Why the parts couldn't be joined (shown quietly under the player).
  note?: string;
}

const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  amr: 'audio/amr',
};

export function audioTypeOf(filename: string | undefined): string {
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_TYPES[ext] ?? 'audio/mpeg';
}

// One continuous recording for every call. Uploads and phone calls already are one file. A
// live call is a chain of short parts (each its own complete file, so it can be transcribed
// on its own); here they are joined into one WebM without re-encoding (webm-join.ts), once —
// when the call ends, or the first time it's played — and kept in GridFS beside the parts,
// which are never touched. More parts later (the call was still going): it is built again.
@Injectable()
export class CallRecordingService {
  private readonly logger = new Logger(CallRecordingService.name);
  // Two people opening the same call at once build it once.
  private readonly building = new Map<string, Promise<CallRecordingInfo>>();

  constructor(
    @InjectModel(CallSession.name) private sessionModel: Model<CallSessionDocument>,
    private gridFs: GridFsService,
  ) {}

  /** The file ids a call's recording is made of, in order. */
  static partsOf(session: Pick<CallSession, 'transcript' | 'originalRecordingFileId'>): string[] {
    const ordered = [...(session.transcript ?? [])].sort((a, b) => a.sequence - b.sequence);
    const ids: string[] = [];
    for (const s of ordered) if (s.audioFileId && s.audioFileId !== session.originalRecordingFileId && !ids.includes(s.audioFileId)) ids.push(s.audioFileId);
    return ids;
  }

  async recordingFor(session: CallSessionDocument): Promise<CallRecordingInfo> {
    if (session.originalRecordingFileId) {
      const segmentStarts: Record<string, number> = {};
      for (const s of session.transcript ?? []) if (typeof s.startSeconds === 'number') segmentStarts[String(s.sequence)] = s.startSeconds;
      return {
        kind: 'original',
        fileId: session.originalRecordingFileId,
        mimeType: audioTypeOf(session.originalFilename),
        durationSeconds: null,
        segmentStarts,
        parts: [],
      };
    }
    const parts = CallRecordingService.partsOf(session);
    if (parts.length === 0) return { kind: 'none', fileId: null, mimeType: null, durationSeconds: null, segmentStarts: {}, parts: [] };
    const built = session.fullRecording;
    if (built?.fileId && built.partCount === parts.length) return this.joinedInfo(built);

    const key = session._id.toString();
    const running = this.building.get(key);
    if (running) return running;
    const work = this.build(session, parts).finally(() => this.building.delete(key));
    this.building.set(key, work);
    return work;
  }

  /** Builds it ahead of time (a call just ended), so the first play is instant. Never throws. */
  prepare(session: CallSessionDocument): void {
    void this.recordingFor(session).catch((err: Error) => this.logger.warn(`Recording for ${session._id} not prepared: ${err.message}`));
  }

  private joinedInfo(built: NonNullable<CallSession['fullRecording']>): CallRecordingInfo {
    const segmentStarts: Record<string, number> = {};
    for (const [sequence, ms] of Object.entries(built.segmentStartsMs ?? {})) segmentStarts[sequence] = ms / 1000;
    return { kind: 'joined', fileId: built.fileId, mimeType: 'audio/webm', durationSeconds: built.durationMs / 1000, segmentStarts, parts: [] };
  }

  private async build(session: CallSessionDocument, parts: string[]): Promise<CallRecordingInfo> {
    // Played one after another — still every second of the call.
    const fallback = (note: string): CallRecordingInfo => ({ kind: 'parts', fileId: null, mimeType: 'audio/webm', durationSeconds: null, segmentStarts: {}, parts, note });
    let buffers: Buffer[];
    try {
      buffers = await Promise.all(parts.map((id) => this.gridFs.download(AUDIO_BUCKET, id)));
    } catch (err) {
      this.logger.warn(`Recording parts of ${session._id} couldn't be read: ${(err as Error).message}`);
      return fallback('Some parts of this recording couldn’t be read.');
    }
    let joined: ReturnType<typeof joinWebmParts>;
    try {
      joined = joinWebmParts(buffers);
    } catch (err) {
      if (!(err instanceof WebmJoinError)) throw err;
      this.logger.log(`Recording of ${session._id} kept in parts: ${err.message}`);
      return fallback('This recording plays in parts.');
    }

    // Where each transcript segment starts: its part's place in the joined recording.
    const startByFile = new Map(parts.map((id, i) => [id, joined.partStartsMs[i]]));
    const segmentStartsMs: Record<string, number> = {};
    for (const s of session.transcript ?? []) {
      const at = s.audioFileId ? startByFile.get(s.audioFileId) : undefined;
      if (at !== undefined) segmentStartsMs[String(s.sequence)] = Math.round(at);
    }
    const id = session._id.toString();
    const fileId = await this.gridFs.upload(AUDIO_BUCKET, `${id}-full.webm`, joined.file, {
      organizationId: session.organizationId,
      sessionId: id,
      kind: 'joined',
      partCount: parts.length,
    });
    const fullRecording = { fileId, durationMs: Math.round(joined.durationMs), partCount: parts.length, segmentStartsMs, builtAt: new Date() };
    const previous = session.fullRecording?.fileId;
    // Only this field: the session may be saving other things (a call still going) at the same time.
    await this.sessionModel.updateOne({ _id: session._id }, { $set: { fullRecording } }).exec();
    session.fullRecording = fullRecording;
    if (previous && previous !== fileId) await this.gridFs.delete(AUDIO_BUCKET, previous).catch(() => undefined);
    this.logger.log(`Recording of ${id} joined: ${parts.length} parts, ${(joined.durationMs / 1000).toFixed(1)} s`);
    return this.joinedInfo(fullRecording);
  }
}
