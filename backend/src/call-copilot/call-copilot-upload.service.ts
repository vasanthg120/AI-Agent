import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { ReservationService } from '../billing/reservation.service';
import { CallCopilotGateway } from './call-copilot.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { CallCopilotService } from './call-copilot.service';
import { CallSession, CallSessionDocument } from './schemas/call-session.schema';
import { UploadCallRecordingDto } from './dto/upload-call-recording.dto';
import {
  NoSpeechFoundError,
  PROCESSING_ABANDONED_AFTER_MS,
  SarvamJobFailedError,
  TRANSCRIPTION_MAX_WAIT_MS,
  TranscriptionTimedOutError,
  describeProcessingFailure,
  isTransientAgentError,
} from './processing-failure';

const AUDIO_BUCKET = 'call_recordings';
const POLL_INTERVAL_MS = 8_000;
// A wedged Sarvam job fails the recording (retryable) instead of polling forever.
const MAX_POLL_MS = TRANSCRIPTION_MAX_WAIT_MS;
// python-agent takes ~1.5 min to come back after a restart, and the Sarvam job
// keeps running on Sarvam's side meanwhile — so a run of failed status checks
// is waited out (≈2.5 min) before the recording is given up on.
const MAX_POLL_ERRORS_IN_A_ROW = 20;
// Handing a recording to python-agent includes python-agent uploading it to
// Sarvam — minutes, not seconds, for a long call on a slow uplink. Past the
// module's 60s default the backend would give up while Sarvam still bills the job.
const CREATE_JOB_TIMEOUT_MS = 10 * 60_000;
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
    private notifications: NotificationsService,
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
    return this.startSessionFromRecording(organizationId, userId, buffer, file.originalname, dto);
  }

  /** A recording that arrives as bytes rather than a browser upload. Stores
   * it, then processes it: GridFS copy, strict credit reservation, background
   * transcription, summary, AI Coach. A refused credit hold is thrown (the
   * uploader sees it); the stored recording stays retryable either way. */
  async startSessionFromRecording(
    organizationId: string,
    userId: string,
    buffer: Buffer,
    filename: string,
    dto: UploadCallRecordingDto,
  ): Promise<CallSessionDocument> {
    const session = await this.storeRecording(organizationId, userId, buffer, filename, dto);
    await this.startProcessing(session, buffer);
    return session;
  }

  /** Step one for every recording: the original file is saved, and its session
   * created, before anything is sent to Sarvam — so no later failure can lose it. */
  async storeRecording(organizationId: string, userId: string, buffer: Buffer, filename: string, dto: UploadCallRecordingDto): Promise<CallSessionDocument> {
    const audioFileId = await this.gridFs.upload(AUDIO_BUCKET, filename, buffer, {
      organizationId,
      uploadedBy: userId,
    });
    return this.sessionModel.create({
      organizationId,
      userId,
      dealId: dto.dealId,
      contactId: dto.contactId,
      status: 'processing',
      source: 'upload',
      originalRecordingFileId: audioFileId,
      originalFilename: filename,
      languageCode: dto.languageCode,
      creditRequestId: randomUUID(),
    });
  }

  /** Step two: holds credits, then transcribes and summarises in the
   * background. Throws only when credits can't be held — the session is then
   * already marked failed (retryable), so it is never left 'processing'. */
  async startProcessing(session: CallSessionDocument, audio: Buffer): Promise<void> {
    try {
      // resolveTenantKey(), not organizationId directly — billing is scoped
      // per-user by default (see ReservationService.resolveTenantKey's own
      // comment); a purchased plan's credits land in the wallet keyed by
      // userId, not organizationId, so reserving against organizationId
      // directly always misses a real balance and throws Insufficient
      // Balance regardless of what was actually purchased.
      await this.reservations.reserve(
        this.reservations.resolveTenantKey(session.organizationId, session.userId),
        session.userId,
        session.creditRequestId,
        session._id.toString(),
      );
    } catch (err) {
      // errorSession's release() is a safe no-op: nothing was reserved.
      await this.failSession(session, err, 'credits', false);
      throw err;
    }

    void this.processUpload(session, audio).catch((err) =>
      this.failSession(session, err, 'processing', true).catch((saveErr) =>
        this.logger.error(`call.processing.fail_save_failed session=${session._id} reason=${(saveErr as Error).message}`),
      ),
    );
  }

  /** Runs a failed (or abandoned) recording through transcription again, from
   * the copy saved in GridFS — never re-downloaded from the phone provider.
   * `userId` limits it to that person's own calls; `languageCode` fills in a
   * session saved before the language was kept on it. */
  async retryProcessing(organizationId: string, sessionId: string, options: { userId?: string; languageCode?: string } = {}): Promise<CallSessionDocument> {
    if (!isValidObjectId(sessionId)) throw new NotFoundException('Call not found.');
    const session = await this.sessionModel.findOne({ _id: sessionId, organizationId, ...(options.userId ? { userId: options.userId } : {}) }).exec();
    if (!session) throw new NotFoundException('Call not found.');
    if (session.source !== 'upload' || !session.originalRecordingFileId) {
      throw new BadRequestException('This call has no saved recording to process again.');
    }
    const updatedAt = (session as { updatedAt?: Date }).updatedAt;
    const abandoned = session.status === 'processing' && !!updatedAt && Date.now() - updatedAt.getTime() > PROCESSING_ABANDONED_AFTER_MS;
    if (session.status !== 'error' && !abandoned) {
      throw new ConflictException(session.status === 'processing' ? 'This call is still being processed.' : 'This call has already been processed.');
    }
    const languageCode = session.languageCode ?? options.languageCode;
    if (!languageCode) {
      throw new BadRequestException('Choose the language spoken in this recording, then try again.');
    }

    let audio: Buffer;
    try {
      audio = await this.gridFs.download(AUDIO_BUCKET, session.originalRecordingFileId);
    } catch {
      throw new BadRequestException('The saved recording for this call is missing, so it can’t be processed again.');
    }

    // Claimed atomically on the state just read, so a double click can't start two runs.
    const claimed = await this.sessionModel
      .findOneAndUpdate(
        { _id: session._id, status: session.status, creditRequestId: session.creditRequestId },
        {
          $set: {
            status: 'processing',
            languageCode,
            creditRequestId: randomUUID(),
            transcript: [],
            events: [],
            recommendations: [],
            lastAnalyzedSequence: 0,
            summaryPoints: [],
            customerNeeds: [],
            concernsRaised: [],
            keyTakeaways: [],
            followUpActions: [],
          },
          $unset: { errorMessage: '', retryable: '', endedAt: '', sentiment: '', headline: '', outcome: '' },
        },
        { new: true },
      )
      .exec();
    if (!claimed) throw new ConflictException('This call is already being processed again.');
    this.logger.log(`call.processing.retry org=${organizationId} session=${sessionId} previous=${session.status}`);
    await this.startProcessing(claimed, audio);
    return claimed;
  }

  /** Marks the session failed with words the user can act on; the technical
   * reason goes to the log only. */
  private async failSession(session: CallSessionDocument, err: unknown, stage: 'credits' | 'processing', notifyLiveView: boolean): Promise<void> {
    const failure = describeProcessingFailure(err);
    const sessionId = session._id.toString();
    this.logger.error(`call.processing.failed org=${session.organizationId} session=${sessionId} stage=${stage} reason=${failure.technical}`);
    await this.callCopilotService.errorSession(session, failure.message, { retryable: !!session.originalRecordingFileId });
    if (notifyLiveView) this.gateway.emitToUser(session.userId, 'call:error', { sessionId, message: failure.message });
  }

  private async processUpload(session: CallSessionDocument, audioBuffer: Buffer): Promise<void> {
    const userId = session.userId;
    const sessionId = session._id.toString();
    const emit = (event: string, payload: object) => this.gateway.emitToUser(userId, event, { sessionId, ...payload });

    if (session.dealId || session.contactId) {
      try {
        const token = this.bridgeToken(userId, session.organizationId);
        const { data } = await firstValueFrom(
          this.http.post<{ contextBlob: string }>(
            `${this.pythonAgentUrl}/call-copilot/context`,
            { sessionId, query: 'uploaded sales call', dealId: session.dealId, contactId: session.contactId },
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

    // Always set by storeRecording/retryProcessing; never guessed (python-agent refuses to).
    if (!session.languageCode) throw new Error(`session ${sessionId} has no languageCode`);
    const jobId = await this.createTranscribeJob(session, audioBuffer, session.languageCode);
    const segments = await this.pollUntilTranscribed(session, jobId);
    // An empty transcript would otherwise "succeed" as a call with no summary.
    if (!segments.some((s) => s.text?.trim())) throw new NoSpeechFoundError();
    this.logger.log(`call.processing.transcribed session=${sessionId} segments=${segments.length}`);

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

    // AI Sales Coach — same fire-and-forget-then-emit shape as
    // call-copilot.gateway.ts's onEnd handler for a live call; not awaited
    // before processUpload returns so it never adds latency to the upload
    // pipeline's own already-async completion.
    void this.callCopilotService
      .generateCoaching(ended, fullText)
      .then((coached) => {
        // A phone call's report is complete (the Dialer shows it as ready from here).
        if (/^(plivo|twilio)-/.test(coached.originalFilename ?? '')) {
          this.logger.log(`call.report.ready org=${coached.organizationId} user=${coached.userId} session=${sessionId} score=${coached.overallScore ?? 'none'}`);
          // No customer name or number in a lock-screen message.
          const score = coached.overallScore !== undefined ? ` Score ${coached.overallScore.toFixed(1)}/10.` : '';
          void this.notifications.pushToDialer(coached.userId, coached.organizationId, {
            title: 'Your call report is ready',
            body: `${coached.headline ?? 'Summary, score and coaching tips are in.'}${score}`.slice(0, 180),
            url: `/dialer/report/session/${sessionId}`,
          });
        }
        emit('call:coaching', {
          overallScore: coached.overallScore,
          categoryScores: coached.categoryScores,
          whatWentWell: coached.whatWentWell,
          whatToImprove: coached.whatToImprove,
          whatWouldHaveDoneDifferently: coached.whatWouldHaveDoneDifferently,
          nextCallFocus: coached.nextCallFocus,
          keyMoments: coached.keyMoments,
          coachingSummary: coached.coachingSummary,
          voiceScript: coached.voiceScript,
        });
      })
      .catch((err: Error) => this.logger.warn(`Call copilot coaching emit failed for session ${sessionId}: ${err.message}`));
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
        timeout: CREATE_JOB_TIMEOUT_MS,
      }),
    );
    this.logger.log(`call.processing.job_started session=${session._id} bytes=${audioBuffer.length} language=${languageCode}`);
    return data.jobId;
  }

  /** Polls every ~8s, touch()-ing the credit reservation each cycle so a
   * long-running job (Sarvam batch STT + queueing) doesn't get force-released
   * by ReservationService's 5-minute sweep before this pipeline ever gets to
   * settle() — see reservation.service.ts's own comment on touch(). A failed
   * status check (python-agent restarting, a network blip) is retried: the
   * job itself keeps running on Sarvam's side. */
  private async pollUntilTranscribed(session: CallSessionDocument, jobId: string): Promise<UploadTranscribeSegment[]> {
    const deadline = Date.now() + MAX_POLL_MS;
    let errorsInARow = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      await this.reservations.touch(session.creditRequestId);

      const token = this.bridgeToken(session.userId, session.organizationId);
      let data: { status: 'processing' | 'completed' | 'failed'; segments: UploadTranscribeSegment[]; error?: string };
      try {
        ({ data } = await firstValueFrom(
          this.http.get<typeof data>(`${this.pythonAgentUrl}/call-copilot/upload/transcribe-job/${jobId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ));
        errorsInARow = 0;
      } catch (err) {
        errorsInARow += 1;
        if (!isTransientAgentError(err) || errorsInARow >= MAX_POLL_ERRORS_IN_A_ROW) throw err;
        this.logger.warn(`call.processing.poll_retry session=${session._id} attempt=${errorsInARow} reason=${describeProcessingFailure(err).technical}`);
        continue;
      }

      if (data.status === 'processing') continue;
      if (data.status === 'failed') throw new SarvamJobFailedError(data.error || 'no reason given');
      return data.segments;
    }
    throw new TranscriptionTimedOutError();
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
