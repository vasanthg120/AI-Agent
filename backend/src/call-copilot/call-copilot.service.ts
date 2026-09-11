import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import FormData from 'form-data';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { ReservationService } from '../billing/reservation.service';
import { CallSession, CallSessionDocument } from './schemas/call-session.schema';

const AUDIO_BUCKET = 'call_recordings';

export interface AnalyzeResult {
  skipped: boolean;
  sentiment?: string;
  events: { type: string; text: string }[];
  recommendations: { type: string; text: string }[];
}

// Real-Time AI Sales Call Copilot — session lifecycle, GridFS storage, and
// the bridge to python-agent's /call-copilot/* routes. Mirrors VoiceService's
// bridgeToken idiom exactly (a short-lived service JWT, never a static
// secret) for every python-agent call; billing reuses ReservationService
// directly (in-process, no HTTP round trip — unlike python-agent's own
// chat-turn billing, which has to cross the process boundary).
@Injectable()
export class CallCopilotService {
  private readonly logger = new Logger(CallCopilotService.name);
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(CallSession.name) private sessionModel: Model<CallSessionDocument>,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
    private gridFs: GridFsService,
    private reservations: ReservationService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  private bridgeToken(userId: string, organizationId: string): string {
    return this.jwt.sign({ sub: userId, organizationId }, { expiresIn: '10m' });
  }

  async getSession(organizationId: string, userId: string, sessionId: string): Promise<CallSessionDocument | null> {
    return this.sessionModel.findOne({ _id: sessionId, organizationId, userId }).exec();
  }

  async listSessions(organizationId: string, userId: string): Promise<CallSessionDocument[]> {
    return this.sessionModel
      .find({ organizationId, userId })
      .select({ transcript: 0 }) // history list doesn't need the full transcript payload
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
  }

  /** Creates the session, reserves one credit hold for its whole duration
   * (see the schema's own comment on why this is one reservation, not
   * per-analysis-tick metering), and fetches the initial CRM/RAG/Mem0
   * context blob once — never re-fetched for the rest of the call. */
  async startSession(
    organizationId: string,
    userId: string,
    dealId: string | undefined,
    contactId: string | undefined,
    contextQuery: string,
  ): Promise<CallSessionDocument> {
    const creditRequestId = randomUUID();
    const session = await this.sessionModel.create({
      organizationId,
      userId,
      dealId,
      contactId,
      status: 'active',
      creditRequestId,
    });

    // Best-effort, matching chat's own reserve() semantics — an org with no
    // billing context configured (shouldn't happen behind JwtAuthGuard, but
    // reserve() itself already no-ops safely) never blocks a call from
    // starting; a genuine insufficient-balance 402 is the one case worth
    // surfacing to the caller before any recording begins.
    try {
      await this.reservations.reserve(organizationId, userId, creditRequestId, session._id.toString());
    } catch (err) {
      this.logger.warn(`Call copilot billing reserve failed (proceeding): ${(err as Error).message}`);
    }

    try {
      const token = this.bridgeToken(userId, organizationId);
      const { data } = await firstValueFrom(
        this.http.post<{ contextBlob: string }>(
          `${this.pythonAgentUrl}/call-copilot/context`,
          { sessionId: session._id.toString(), query: contextQuery, dealId, contactId },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      session.contextBlob = data.contextBlob;
      await session.save();
    } catch (err) {
      // A missing context blob degrades the copilot's recommendations, but
      // must never block the call from starting — the salesperson is
      // already on the phone by the time this UI would even show an error.
      this.logger.warn(`Call copilot context fetch failed for session ${session._id}: ${(err as Error).message}`);
    }

    return session;
  }

  /** One audio segment: stored in GridFS (its own independently-playable
   * file — see the schema's comment on why segments aren't concatenated),
   * transcribed via the existing batch Sarvam endpoint, appended to the
   * session's transcript. Returns the new segment's text (empty string for
   * a silent/empty segment — not an error). */
  async appendAudioSegment(
    session: CallSessionDocument,
    sequence: number,
    audioBuffer: Buffer,
    mimeType: string,
    languageCode: string,
  ): Promise<string> {
    const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const audioFileId = await this.gridFs.upload(AUDIO_BUCKET, `${session._id.toString()}-${sequence}.${extension}`, audioBuffer, {
      organizationId: session.organizationId,
      sessionId: session._id.toString(),
      sequence,
    });

    let transcript = '';
    try {
      const token = this.bridgeToken(session.userId, session.organizationId);
      const form = new FormData();
      form.append('audio', audioBuffer, { filename: `segment.${extension}`, contentType: mimeType });
      form.append('languageCode', languageCode);
      const { data } = await firstValueFrom(
        this.http.post<{ transcript: string }>(`${this.pythonAgentUrl}/call-copilot/transcribe`, form, {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }),
      );
      transcript = data.transcript;
    } catch (err) {
      // The segment's audio is already safely in GridFS regardless — a
      // transcription hiccup loses this segment's text but never the
      // recording, and never tears down the session (see gateway's
      // 'call:warning' handling).
      this.logger.warn(`Call copilot transcribe failed for session ${session._id} seg ${sequence}: ${(err as Error).message}`);
    }

    session.transcript.push({ sequence, text: transcript, audioFileId, recordedAt: new Date() } as never);
    await session.save();
    return transcript;
  }

  /** Throttling itself happens on the python-agent side (Redis rate limiter
   * + minimum-new-words gate — see routes/call_copilot.py's own comment);
   * this always calls through and trusts the `skipped` flag back. Only the
   * transcript accumulated since the last SUCCESSFUL (non-skipped) analysis
   * is sent, so a skipped cycle's word count keeps building toward the
   * threshold rather than resetting. */
  async maybeAnalyze(session: CallSessionDocument): Promise<AnalyzeResult> {
    const newSegments = session.transcript.filter((s) => s.sequence > session.lastAnalyzedSequence);
    const newText = newSegments
      .map((s) => s.text)
      .filter(Boolean)
      .join(' ');

    if (!newText.trim()) {
      return { skipped: true, events: [], recommendations: [] };
    }

    try {
      const token = this.bridgeToken(session.userId, session.organizationId);
      const { data } = await firstValueFrom(
        this.http.post<AnalyzeResult>(
          `${this.pythonAgentUrl}/call-copilot/analyze`,
          {
            sessionId: session._id.toString(),
            contextBlob: session.contextBlob ?? '',
            transcriptWindow: newText,
            alreadyDetected: session.events.map((e) => e.type),
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      if (!data.skipped) {
        session.lastAnalyzedSequence = newSegments[newSegments.length - 1].sequence;
        session.sentiment = data.sentiment ?? session.sentiment;
        for (const event of data.events) session.events.push(event as never);
        for (const rec of data.recommendations) session.recommendations.push(rec as never);
        await session.save();
      }
      return data;
    } catch (err) {
      this.logger.warn(`Call copilot analyze failed for session ${session._id}: ${(err as Error).message}`);
      return { skipped: true, events: [], recommendations: [] };
    }
  }

  /** Ends the call: settles the credit reservation, runs the one-shot final
   * summary, and marks the session ended. Follow-up actions are stored for
   * display only — nothing is written back to the CRM automatically (per
   * the confirmed requirement; the salesperson decides what to action). */
  async endSession(session: CallSessionDocument): Promise<CallSessionDocument> {
    try {
      const token = this.bridgeToken(session.userId, session.organizationId);
      const fullTranscript = session.transcript
        .map((s) => s.text)
        .filter(Boolean)
        .join(' ');
      const { data } = await firstValueFrom(
        this.http.post<{ summary: string; keyTakeaways: string[]; followUpActions: { text: string; priority: string }[] }>(
          `${this.pythonAgentUrl}/call-copilot/summarize`,
          {
            sessionId: session._id.toString(),
            contextBlob: session.contextBlob ?? '',
            fullTranscript,
            detectedEvents: session.events.map((e) => e.text),
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      session.summary = data.summary;
      session.keyTakeaways = data.keyTakeaways;
      session.followUpActions = data.followUpActions as never;
    } catch (err) {
      this.logger.warn(`Call copilot summarize failed for session ${session._id}: ${(err as Error).message}`);
    }

    session.status = 'ended';
    session.endedAt = new Date();
    await session.save();

    try {
      await this.reservations.settle(session.creditRequestId);
    } catch (err) {
      this.logger.warn(`Call copilot billing settle failed for session ${session._id}: ${(err as Error).message}`);
    }

    return session;
  }

  /** A session that errors out (client disconnect mid-call, an unhandled
   * exception) releases its credit hold instead of leaving it pending
   * forever — same reasoning as chat's release() on a failed turn. */
  async errorSession(session: CallSessionDocument, message: string): Promise<void> {
    session.status = 'error';
    session.errorMessage = message;
    session.endedAt = new Date();
    await session.save();
    try {
      await this.reservations.release(session.creditRequestId);
    } catch (err) {
      this.logger.warn(`Call copilot billing release failed for session ${session._id}: ${(err as Error).message}`);
    }
  }
}
