import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { Connection, Model, Types } from 'mongoose';
import { join } from 'path';
import { GridFsService } from '../../common/gridfs/gridfs.service';
import { CallSession, CallSessionDocument, CallSessionSchema } from '../schemas/call-session.schema';
import { CallRecordingService } from './call-recording.service';
import { joinWebmParts, readWebmPart } from './webm-join';

// Every call as one recording: an upload's original file, or a live call's parts joined
// once and kept (built again only if parts were added). Real Mongo and GridFS; the parts
// are real MediaRecorder WebM files.
const parts = [0, 1, 2].map((i) => readFileSync(join(__dirname, 'fixtures', `part-${i}.webm`)));

describe('CallRecordingService (real Mongo + GridFS)', () => {
  let connection: Connection;
  let model: Model<CallSessionDocument>;
  let gridFs: GridFsService;
  let service: CallRecordingService;
  const org = new Types.ObjectId().toString();
  const made: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: CallSession.name, schema: CallSessionSchema }])],
      providers: [GridFsService, CallRecordingService],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    model = moduleRef.get(getModelToken(CallSession.name));
    gridFs = moduleRef.get(GridFsService);
    service = moduleRef.get(CallRecordingService);
  });

  afterAll(async () => {
    const files = await connection.db!.collection('call_recordings.files').find({ 'metadata.organizationId': org }).toArray();
    for (const f of files) await gridFs.delete('call_recordings', f._id.toString()).catch(() => undefined);
    await model.collection.deleteMany({ organizationId: org });
    await connection.close();
  });

  /** A live call whose segments point at these parts (one segment per part, as the live recorder makes them). */
  async function liveCall(buffers: Buffer[]): Promise<CallSessionDocument> {
    const _id = new Types.ObjectId();
    const transcript: { sequence: number; text: string; audioFileId: string; recordedAt: Date }[] = [];
    for (let i = 0; i < buffers.length; i += 1) {
      const fileId = await gridFs.upload('call_recordings', `${_id}-${i}.webm`, buffers[i], { organizationId: org, sessionId: _id.toString(), sequence: i });
      transcript.push({ sequence: i, text: `line ${i}`, audioFileId: fileId, recordedAt: new Date() });
    }
    await model.collection.insertOne({ _id, organizationId: org, userId: 'u1', creditRequestId: new Types.ObjectId().toString(), source: 'live', status: 'ended', transcript });
    made.push(_id.toString());
    return (await model.findById(_id))!;
  }

  it('a live call: its parts joined into one recording — the full length, and where each line starts', async () => {
    const session = await liveCall(parts);
    const info = await service.recordingFor(session);
    const joined = joinWebmParts(parts);
    expect(info.kind).toBe('joined');
    expect(info.mimeType).toBe('audio/webm');
    expect(info.durationSeconds).toBeCloseTo(joined.durationMs / 1000, 2);
    expect(info.segmentStarts).toEqual({ '0': 0, '1': Math.round(joined.partStartsMs[1]) / 1000, '2': Math.round(joined.partStartsMs[2]) / 1000 });
    // Kept in GridFS: the file plays, and it's one file.
    const file = await gridFs.download('call_recordings', info.fileId!);
    expect(readWebmPart(file).frames.length).toBe(readWebmPart(joined.file).frames.length);
    // The parts themselves are untouched.
    expect((await gridFs.download('call_recordings', session.transcript[1].audioFileId)).equals(parts[1])).toBe(true);
  });

  it('built once: opening it again (or two people at once) uses the same file', async () => {
    const session = await liveCall(parts);
    const [a, b] = await Promise.all([service.recordingFor(session), service.recordingFor(session)]);
    expect(a.fileId).toBe(b.fileId);
    const again = await service.recordingFor((await model.findById(session._id))!);
    expect(again.fileId).toBe(a.fileId);
    expect(await connection.db!.collection('call_recordings.files').countDocuments({ 'metadata.sessionId': session._id.toString(), 'metadata.kind': 'joined' })).toBe(1);
  });

  it('more parts since (the call went on): built again, the old file removed', async () => {
    const session = await liveCall(parts.slice(0, 2));
    const first = await service.recordingFor(session);
    const fileId = await gridFs.upload('call_recordings', `${session._id}-2.webm`, parts[2], { organizationId: org, sessionId: session._id.toString(), sequence: 2 });
    await model.collection.updateOne({ _id: session._id }, { $push: { transcript: { sequence: 2, text: 'line 2', audioFileId: fileId, recordedAt: new Date() } } } as never);
    const second = await service.recordingFor((await model.findById(session._id))!);
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.durationSeconds!).toBeGreaterThan(first.durationSeconds!);
    await expect(gridFs.download('call_recordings', first.fileId!)).rejects.toThrow();
  });

  it('parts that can’t be joined (not WebM) still play — one after another, every one of them', async () => {
    const session = await liveCall([Buffer.from('not a webm file at all'), parts[1]]);
    const info = await service.recordingFor(session);
    expect(info).toMatchObject({ kind: 'parts', fileId: null, note: 'This recording plays in parts.' });
    expect(info.parts).toEqual(session.transcript.map((s) => s.audioFileId));
  });

  it('an upload or phone call is its own original file, as it came; nothing recorded is said', async () => {
    const _id = new Types.ObjectId();
    const original = await gridFs.upload('call_recordings', 'call.mp3', Buffer.from('ID3 fake mp3'), { organizationId: org });
    await model.collection.insertOne({
      _id,
      organizationId: org,
      userId: 'u1',
      creditRequestId: new Types.ObjectId().toString(),
      source: 'upload',
      status: 'ended',
      originalRecordingFileId: original,
      originalFilename: 'plivo-call.mp3',
      transcript: [
        { sequence: 0, text: 'hello', audioFileId: original, startSeconds: 0 },
        { sequence: 1, text: 'hi', audioFileId: original, startSeconds: 4.2 },
      ],
    });
    const info = await service.recordingFor((await model.findById(_id))!);
    expect(info).toEqual({ kind: 'original', fileId: original, mimeType: 'audio/mpeg', durationSeconds: null, segmentStarts: { '0': 0, '1': 4.2 }, parts: [] });

    const empty = new Types.ObjectId();
    await model.collection.insertOne({ _id: empty, organizationId: org, userId: 'u1', creditRequestId: new Types.ObjectId().toString(), source: 'live', status: 'ended', transcript: [] });
    expect((await service.recordingFor((await model.findById(empty))!)).kind).toBe('none');
  });
});
