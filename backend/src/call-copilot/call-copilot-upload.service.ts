import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { ReservationService } from '../billing/reservation.service';
import { CallCopilotGateway } from './call-copilot.gateway';
import { CallCopilotService } from './call-copilot.service';
import { CallSession, CallSessionDocument } from './schemas/call-session.schema';
import { UploadCallRecordingDto } from './dto/upload-call-recording.dto';

const AUDIO_BUCKET = 'call_recordings';
const POLL_INTERVAL_MS = 8_000;
// A generous ceiling on the WHOLE background pipeline (job creation through
// summary), not just Sarvam's own job — well above Sarvam's documented 2h
// file-length cap plus room for several analysis passes, so a wedged Sarvam
// job fails the upload outright instead of polling forever.
const MAX_POLL_MS = 60 * 60_000;
// Mirrors python-agent's settings.call_copilot_transcript_window_words
// (default 500) — NestJS has no access to that Python-side config object, so
// this is kept as its own constant, deliberately the same value. Unlike the
// live path (which sends "everything new since last analysis," bounded
// naturally by how much can accumulate in ~25s), an upload's ALREADY-COMPLETE
// transcript has to be explicitly chunked or one analysis call would receive
// an entire 30-minute call's transcript at once.
const ANALYSIS_WINDOW_WORDS = 500;

interface UploadTranscribeSegment {
  sequence: number;
  text: string;
  speaker?: string;
}

// Real-Time AI Sales Call Copilot — "Upload a Recording" flow. Kept as its
// own service (not folded into the already-substantial CallCopilotService)
// mirroring how BusinessKnowledgeGridFsService is split from
// BusinessKnowledgeDocumentsService. Everything about session lifecycle past
// the initial create — appendTranscriptSegment, runBatchAnalysisWindow,
// endSession, errorSession — is reused unchanged from CallCopilotService;
// this service owns ONLY the upload-specific orchestration (Sarvam batch
// job creation/polling, progress push) around those calls.
@Injectable()
export class CallCopilotUploadService {
  private readonly logger = new Logger(CallCopilotUploadService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(CallSession.name) private sessionModel: Model<CallSessionDocument>,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private gridFs: GridFsService,
    private reservations: ReservationService,
    private callCopilotService: CallCopilotService,
    private gateway: CallCopilotGateway,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private bridgeToken(userId: string, organizationId: string): string {
    return this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '10m' });
  }

  /** GridFS-uploads the original file, creates a 'processing' session,
   * reserves credits (STRICTLY — unlike the live path's best-effort reserve,
   * an upload has no "salesperson already on the phone" urgency, so a
   * genuine insufficient-balance error should stop it before any Sarvam/
   * Claude spend is incurred), kicks off background processing, and returns
   * immediately. The controller responds with the session before processing
   * completes — progress arrives via Socket.IO (see processUpload below). */
  async startUploadSession(
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
    dto: UploadCallRecordingDto,
  ): Promise<CallSessionDocument> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file.path);
    } finally {
      // Multer's disk storage does NOT clean up after itself — this temp
      // file is ours to delete once we've read it, regardless of what
      // happens afterward (including a thrown error below).
      await fs.unlink(file.path).catch(() => undefined);
    }

    const audioFileId = await this.gridFs.upload(AUDIO_BUCKET, file.originalname, buffer, {
      organizationId,
      uploadedBy: userId,
    });

    const creditRequestId = randomUUID();
    const session = await this.sessionModel.create({
      organizationId,
      userId,
      dealId: dto.dealId,
      contactId: dto.contactId,
      status: 'processing',
      source: 'upload',
      originalRecordingFileId: audioFileId,
      originalFilename: file.originalname,
      creditRequestId,
    });

    try {
      await this.reservations.reserve(organizationId, userId, creditRequestId, session._id.toString());
    } catch (err) {
      // The session was already created (and its audio already safely in
      // GridFS) above — a failed reservation must still mark it 'error'
      // before this method's caller sees the thrown 402, or the session is
      // left stuck in 'processing' forever with no way to resolve (the
      // exact class of bug already hit once for a mic-permission-denied
      // live call — see useSegmentedRecording.ts's own history on this).
      // errorSession's own release() call is a safe no-op here since
      // reserve() never actually created a reservation to release.
      await this.callCopilotService.errorSession(session, 'Insufficient credits to process this recording.');
      throw err;
    }

    void this.processUpload(session, buffer, dto).catch(async (err) => {
      const message = 'Processing this recording failed. The original file was saved.';
      this.logger.error(`Call copilot upload processing failed for session ${session._id}: ${(err as Error).message}`);
      await this.callCopilotService.errorSession(session, (err as Error).message);
      this.gateway.emitToUser(userId, 'call:error', { sessionId: session._id.toString(), message });
    });

    return session;
  }

  private async processUpload(session: CallSessionDocument, audioBuffer: Buffer, dto: UploadCallRecordingDto): Promise<void> {
    const userId = session.userId;
    const sessionId = session._id.toString();
    const emit = (event: string, payload: object) => this.gateway.emitToUser(userId, event, { sessionId, ...payload });

    if (dto.dealId || dto.contactId) {
      try {
        const token = this.bridgeToken(userId, session.organizationId);
        const { data } = await firstValueFrom(
          this.http.post<{ contextBlob: string }>(
            `${this.pythonAgentUrl}/call-copilot/context`,
            { sessionId, query: 'uploaded sales call', dealId: dto.dealId, contactId: dto.contactId },
            { headers: { Authorization: `Bearer ${token}` } },
          ),
        );
        session.contextBlob = data.contextBlob;
        await session.save();
      } catch (err) {
        // Degrades the copilot's analysis/summary, but must never block
        // processing — same reasoning as the live path's identical case.
        this.logger.warn(`Call copilot upload context fetch failed for session ${sessionId}: ${(err as Error).message}`);
      }
    }
    emit('call:contextReady', { contextBlob: session.contextBlob ?? '' });

    const jobId = await this.createTranscribeJob(session, audioBuffer, dto.languageCode);
    const segments = await this.pollUntilTranscribed(session, jobId);

    for (const seg of segments) {
      await this.callCopilotService.appendTranscriptSegment(session, seg.sequence, seg.text, seg.speaker, session.originalRecordingFileId!);
      if (seg.text) emit('call:transcript', { sequence: seg.sequence, text: seg.text });
    }

    const fullText = segments
      .map((s) => s.text)
      .filter(Boolean)
      .join(' ');
    for (const window of chunkWords(fullText, ANALYSIS_WINDOW_WORDS)) {
      await this.reservations.touch(session.creditRequestId);
      const result = await this.callCopilotService.runBatchAnalysisWindow(session, window);
      if (!result.skipped) {
        emit('call:analysis', { sentiment: result.sentiment, events: result.events, recommendations: result.recommendations });
      }
    }

    const ended = await this.callCopilotService.endSession(session);
    emit('call:summary', {
      headline: ended.headline,
      outcome: ended.outcome,
      summaryPoints: ended.summaryPoints,
      customerNeeds: ended.customerNeeds,
      concernsRaised: ended.concernsRaised,
      summary: ended.summary,
      keyTakeaways: ended.keyTakeaways,
      followUpActions: ended.followUpActions,
    });
  }

  private async createTranscribeJob(session: CallSessionDocument, audioBuffer: Buffer, languageCode: string): Promise<string> {
    const token = this.bridgeToken(session.userId, session.organizationId);
    const form = new FormData();
    form.append('audio', audioBuffer, { filename: session.originalFilename ?? 'recording', contentType: 'application/octet-stream' });
    form.append('languageCode', languageCode);
    const { data } = await firstValueFrom(
      this.http.post<{ jobId: string }>(`${this.pythonAgentUrl}/call-copilot/upload/transcribe-job`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }),
    );
    return data.jobId;
  }

  /** Polls every ~8s, touch()-ing the credit reservation each cycle so a
   * long-running job (Sarvam batch STT + queueing) doesn't get force-released
   * by ReservationService's 5-minute sweep before this pipeline ever gets to
   * settle() — see reservation.service.ts's own comment on touch(). */
  private async pollUntilTranscribed(session: CallSessionDocument, jobId: string): Promise<UploadTranscribeSegment[]> {
    const deadline = Date.now() + MAX_POLL_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      await this.reservations.touch(session.creditRequestId);

      const token = this.bridgeToken(session.userId, session.organizationId);
      const { data } = await firstValueFrom(
        this.http.get<{ status: 'processing' | 'completed' | 'failed'; segments: UploadTranscribeSegment[]; error?: string }>(
          `${this.pythonAgentUrl}/call-copilot/upload/transcribe-job/${jobId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      if (data.status === 'processing') continue;
      if (data.status === 'failed') throw new Error(data.error || 'Transcription failed.');
      return data.segments;
    }
    throw new Error('Transcription timed out.');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Splits an already-complete transcript into fixed-size word windows for
// batch-mode analysis — the live path never needs this (it naturally windows
// by "however much accumulated since last analysis"), but a whole call's
// transcript has to be explicitly chunked or one analysis call would receive
// the entire thing at once.
function chunkWords(text: string, wordsPerChunk: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  return chunks;
}
