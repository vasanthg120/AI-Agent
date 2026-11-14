import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import FormData from 'form-data';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { ReservationService } from '../billing/reservation.service';
import { CallSession, CallSessionDocument } from './schemas/call-session.schema';
import { sessionRangeEnd, sessionRangeStart } from './session-date-range';
import { AI_REPORT_TIMEOUT_MS, COACHING_ABANDONED_AFTER_MS, describeCoachingFailure } from './processing-failure';

const AUDIO_BUCKET = 'call_recordings';

/** The Call Library's status and score filters, as a Mongo condition. */
export function callFilterMatch(options: { status?: string; score?: string }): Record<string, unknown>[] {
  const and: Record<string, unknown>[] = [];
  if (options.status) and.push({ status: options.status });
  if (options.score === 'good') and.push({ overallScore: { $gte: 7 } });
  else if (options.score === 'fair') and.push({ overallScore: { $gte: 5, $lt: 7 } });
  else if (options.score === 'low') and.push({ overallScore: { $gt: 0, $lt: 5 } });
  else if (options.score === 'none') and.push({ $or: [{ overallScore: { $exists: false } }, { overallScore: 0 }] });
  return and;
}

/** An AI Coach run has started for this call and hasn't finished, failed or been abandoned. */
export function coachingInProgress(
  session: Pick<CallSession, 'coachingStartedAt' | 'coachingGeneratedAt' | 'coachingError'>,
  now = Date.now(),
): boolean {
  const started = session.coachingStartedAt?.getTime();
  if (!started || session.coachingError) return false;
  if (session.coachingGeneratedAt && session.coachingGeneratedAt.getTime() >= started) return false;
  return now - started < COACHING_ABANDONED_AFTER_MS;
}

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

  /** Powers the Call Library page — a separate endpoint from listSessions
   * above (which stays untouched for whatever already calls it) since this
   * one has two genuinely different modes: plain filtered/paginated browsing
   * when `q` is empty, or a ranked semantic-search hydrate when it's not.
   * Search results are a ranked top-N, not a stable paginated set — the
   * caller shows "top matches" rather than page controls in that mode. */
  async searchSessions(
    organizationId: string,
    userId: string,
    options: { q?: string; dealId?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number; status?: string; score?: string },
  ): Promise<{ items: CallSessionDocument[]; total: number; page: number; pageSize: number; mode: 'browse' | 'search' }> {
    const query = options.q?.trim();
    if (query) {
      const token = this.bridgeToken(userId, organizationId);
      const { data } = await firstValueFrom(
        this.http.post<{ hits: { sessionId: string; score: number; snippet: string; sourceType: string }[] }>(
          `${this.pythonAgentUrl}/call-copilot/search`,
          { query },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      const match: Record<string, unknown> = { _id: { $in: data.hits.map((h) => h.sessionId) }, organizationId, userId };
      if (options.dealId) match.dealId = options.dealId;
      const docs = await this.sessionModel.find(match).select({ transcript: 0 }).exec();
      const byId = new Map(docs.map((d) => [d._id.toString(), d]));
      // Preserve the SEARCH's ranking (best match first), not Mongo's own
      // find() order — hits are already sorted best-first by
      // hybrid_search.search's rerank step.
      const items = data.hits.map((h) => byId.get(h.sessionId)).filter(Boolean) as CallSessionDocument[];
      return { items, total: items.length, page: 1, pageSize: items.length, mode: 'search' };
    }

    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const match: Record<string, unknown> = { organizationId, userId };
    if (options.dealId) match.dealId = options.dealId;
    const filters = callFilterMatch(options);
    if (filters.length) match.$and = filters;
    if (options.dateFrom || options.dateTo) {
      const range: Record<string, Date> = {};
      if (options.dateFrom) range.$gte = sessionRangeStart(options.dateFrom);
      if (options.dateTo) range.$lte = sessionRangeEnd(options.dateTo);
      match.createdAt = range;
    }

    const [items, total] = await Promise.all([
      this.sessionModel
        .find(match)
        .select({ transcript: 0 })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.sessionModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize, mode: 'browse' };
  }

  /** Any session by id, whoever made it — the caller decides whether it may be shown (TeamScopeService.canSee). */
  async findSessionById(sessionId: string): Promise<CallSessionDocument | null> {
    if (!isValidObjectId(sessionId)) return null;
    return this.sessionModel.findById(sessionId).exec();
  }

  /**
   * The Call Library across a team. `owners` is a filter TeamScopeService's
   * scope was turned into (which businesses, which people) — never the
   * client's. Words are matched in the summary and the transcript (the
   * semantic search only covers the caller's own calls), page by page.
   */
  async browseTeamSessions(
    owners: Record<string, unknown>,
    options: { q?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number; status?: string; score?: string },
  ): Promise<{ items: CallSessionDocument[]; total: number; page: number; pageSize: number; mode: 'browse' }> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    const and: Record<string, unknown>[] = [owners, ...callFilterMatch(options)];
    if (options.dateFrom || options.dateTo) {
      const range: Record<string, Date> = {};
      if (options.dateFrom) range.$gte = sessionRangeStart(options.dateFrom);
      if (options.dateTo) range.$lte = sessionRangeEnd(options.dateTo);
      and.push({ createdAt: range });
    }
    const words = options.q?.trim();
    if (words) {
      const pattern = new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      and.push({
        $or: [{ headline: pattern }, { summary: pattern }, { summaryPoints: pattern }, { keyTakeaways: pattern }, { originalFilename: pattern }, { 'transcript.text': pattern }],
      });
    }
    const match = { $and: and };
    const [items, total] = await Promise.all([
      this.sessionModel
        .find(match)
        .select({ transcript: 0 })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.sessionModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize, mode: 'browse' };
  }

  /** getStats across a team (see browseTeamSessions). */
  async getTeamStats(owners: Record<string, unknown>): Promise<{ total: number; last7Days: number; live: number; uploaded: number; avgScore: number | null; scored: number }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const within = (extra: Record<string, unknown>) => ({ $and: [owners, extra] });
    const [total, last7Days, live, uploaded, scores] = await Promise.all([
      this.sessionModel.countDocuments(owners).exec(),
      this.sessionModel.countDocuments(within({ createdAt: { $gte: sevenDaysAgo } })).exec(),
      this.sessionModel.countDocuments(within({ $or: [{ source: 'live' }, { source: { $exists: false } }] })).exec(),
      this.sessionModel.countDocuments(within({ source: 'upload' })).exec(),
      this.sessionModel
        .aggregate<{ _id: null; avg: number; n: number }>([{ $match: within({ overallScore: { $gt: 0 } }) }, { $group: { _id: null, avg: { $avg: '$overallScore' }, n: { $sum: 1 } } }])
        .exec(),
    ]);
    const avg = scores[0]?.avg;
    return { total, last7Days, live, uploaded, avgScore: typeof avg === 'number' ? Math.round(avg * 10) / 10 : null, scored: scores[0]?.n ?? 0 };
  }

  /** Backs the Call Library's StatTile summary row — computed independently
   * of whatever page is currently loaded, so the numbers stay accurate
   * regardless of pagination/search state. */
  async getStats(organizationId: string, userId: string): Promise<{ total: number; last7Days: number; live: number; uploaded: number; avgSentiment: string | null }> {
    const base = { organizationId, userId };
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const [total, last7Days, live, uploaded, sentiments] = await Promise.all([
      this.sessionModel.countDocuments(base).exec(),
      this.sessionModel.countDocuments({ ...base, createdAt: { $gte: sevenDaysAgo } }).exec(),
      // $exists:false catches every session created before the `source`
      // field existed — Mongoose applies the schema default ('live') when
      // HYDRATING a fetched document for display, but a raw query filter
      // like {source:'live'} only matches what's actually stored in Mongo,
      // so every pre-upload-feature session would otherwise be invisible to
      // this count despite genuinely being a live call.
      this.sessionModel.countDocuments({ ...base, $or: [{ source: 'live' }, { source: { $exists: false } }] }).exec(),
      this.sessionModel.countDocuments({ ...base, source: 'upload' }).exec(),
      this.sessionModel.find({ ...base, sentiment: { $exists: true, $ne: null } }).select({ sentiment: 1 }).exec(),
    ]);

    let avgSentiment: string | null = null;
    if (sentiments.length > 0) {
      const counts = new Map<string, number>();
      for (const s of sentiments) counts.set(s.sentiment!, (counts.get(s.sentiment!) ?? 0) + 1);
      avgSentiment = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    return { total, last7Days, live, uploaded, avgSentiment };
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
      // resolveTenantKey(), not organizationId directly — billing is scoped
      // per-user by default (see ReservationService.resolveTenantKey's own
      // comment); a purchased plan's credits land in the wallet keyed by
      // userId, not organizationId, so reserving against organizationId
      // directly always misses a real balance and hits Insufficient Balance
      // regardless of what was actually purchased.
      await this.reservations.reserve(this.reservations.resolveTenantKey(organizationId, userId), userId, creditRequestId, session._id.toString());
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
   * session's transcript.
   *
   * Returns `transcript` (empty string for a silent/empty segment — not an
   * error) AND `transcribeFailed`, which the gateway uses to decide whether
   * to emit 'call:warning'. Distinguishing these matters: before this, an
   * empty transcript meant either "genuinely nothing was said" or "the
   * transcribe call to python-agent errored" — indistinguishable from the
   * salesperson's point of view, both silently produced nothing. That silent
   * failure mode is exactly what made a real outage (python-agent/backend
   * briefly down mid-call) look identical to a normal quiet moment, right up
   * until the call-ending "No speech was transcribed" summary — by which
   * point it's too late to do anything about it. Now a real failure surfaces
   * immediately as a warning while the call is still live. */
  async appendAudioSegment(
    session: CallSessionDocument,
    sequence: number,
    audioBuffer: Buffer,
    mimeType: string,
    languageCode: string,
  ): Promise<{ transcript: string; transcribeFailed: boolean }> {
    const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const audioFileId = await this.gridFs.upload(AUDIO_BUCKET, `${session._id.toString()}-${sequence}.${extension}`, audioBuffer, {
      organizationId: session.organizationId,
      sessionId: session._id.toString(),
      sequence,
    });

    let transcript = '';
    let transcribeFailed = false;
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
      // recording, and never tears down the session.
      transcribeFailed = true;
      this.logger.warn(`Call copilot transcribe failed for session ${session._id} seg ${sequence}: ${(err as Error).message}`);
    }

    session.transcript.push({ sequence, text: transcript, audioFileId, recordedAt: new Date() } as never);
    await session.save();
    return { transcript, transcribeFailed };
  }

  /** The batch-upload equivalent of appendAudioSegment's "store the text"
   * half — transcription already happened via Sarvam's Batch STT job (see
   * CallCopilotUploadService), so there's no per-turn GridFS upload or
   * Sarvam call here, just recording the already-known text. `audioFileId`
   * always points at the ONE original uploaded file (every segment of an
   * uploaded call shares it — there's no per-turn clip, since the whole
   * recording went to Sarvam in one shot), unlike a live call where every
   * segment has its own independently-playable GridFS file. */
  async appendTranscriptSegment(
    session: CallSessionDocument,
    sequence: number,
    text: string,
    speaker: string | undefined,
    audioFileId: string,
  ): Promise<void> {
    session.transcript.push({ sequence, text, speaker, audioFileId, recordedAt: new Date() } as never);
    await session.save();
  }

  /** The HTTP-call-and-apply-result half of analysis — factored out of
   * maybeAnalyze so the live path's throttled "everything since
   * lastAnalyzedSequence" strategy and the upload pipeline's fixed
   * word-count-window strategy over an already-complete transcript can each
   * drive it without duplicating the events/recommendations/sentiment merge
   * logic. Callers are responsible for deciding WHAT transcript window to
   * send and for advancing session.lastAnalyzedSequence themselves (only
   * the live path tracks that field — see maybeAnalyze below). */
  private async runAnalysisCall(session: CallSessionDocument, transcriptWindow: string, mode: 'live' | 'batch'): Promise<AnalyzeResult> {
    if (!transcriptWindow.trim()) {
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
            transcriptWindow,
            alreadyDetected: session.events.map((e) => e.type),
            mode,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );

      if (!data.skipped) {
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

    const result = await this.runAnalysisCall(session, newText, 'live');
    if (!result.skipped) {
      session.lastAnalyzedSequence = newSegments[newSegments.length - 1].sequence;
      await session.save();
    }
    return result;
  }

  /** Upload-pipeline entry point: runs one analysis pass over a fixed
   * transcript window (a chunk of an already-complete transcript, not a
   * "since last time" slice — see CallCopilotUploadService), in batch mode
   * (bypasses the live path's rate-limit interval gate on the python-agent
   * side, since there's no real-time clock to pace against). Does not touch
   * lastAnalyzedSequence — that field is meaningless for a transcript that
   * was never built up incrementally in the first place. */
  async runBatchAnalysisWindow(session: CallSessionDocument, transcriptWindow: string): Promise<AnalyzeResult> {
    return this.runAnalysisCall(session, transcriptWindow, 'batch');
  }

  /** Ends the call: settles the credit reservation, runs the one-shot final
   * summary, and marks the session ended. Follow-up actions are stored for
   * display only — nothing is written back to the CRM automatically (per
   * the confirmed requirement; the salesperson decides what to action). The
   * ONE place both the live gateway's call:end handler and the upload
   * pipeline's completion converge, so Qdrant indexing (fire-and-forget,
   * below) covers both flows with no duplicated call site. */
  async endSession(session: CallSessionDocument): Promise<CallSessionDocument> {
    let fullTranscript = '';
    try {
      const token = this.bridgeToken(session.userId, session.organizationId);
      fullTranscript = session.transcript
        .map((s) => s.text)
        .filter(Boolean)
        .join(' ');
      const { data } = await firstValueFrom(
        this.http.post<{
          headline: string;
          outcome: string;
          summaryPoints: string[];
          customerNeeds: string[];
          concernsRaised: string[];
          keyTakeaways: string[];
          followUpActions: { text: string; priority: string; owner: string }[];
        }>(
          `${this.pythonAgentUrl}/call-copilot/summarize`,
          {
            sessionId: session._id.toString(),
            contextBlob: session.contextBlob ?? '',
            fullTranscript,
            detectedEvents: session.events.map((e) => e.text),
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: AI_REPORT_TIMEOUT_MS },
        ),
      );
      session.headline = data.headline;
      session.outcome = data.outcome;
      session.summaryPoints = data.summaryPoints;
      session.customerNeeds = data.customerNeeds;
      session.concernsRaised = data.concernsRaised;
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

    // Fire-and-forget — indexing must never add latency to the "End Call"
    // response the live salesperson is actively waiting on, nor block the
    // upload pipeline's own already-async completion.
    void this.indexSession(session, fullTranscript).catch((err) =>
      this.logger.warn(`Call copilot Qdrant indexing failed for session ${session._id}: ${(err as Error).message}`),
    );

    return session;
  }

  /** Indexes the ended call's transcript + summary into the shared Qdrant
   * collection (python-agent's /call-copilot/index — see that route's own
   * comment) so it surfaces in the Call Library's search. Never called
   * directly except from endSession above. */
  private async indexSession(session: CallSessionDocument, fullTranscript: string): Promise<void> {
    const summaryText = [session.headline, ...session.summaryPoints, ...session.keyTakeaways].filter(Boolean).join('\n');
    if (!fullTranscript.trim() && !summaryText.trim()) return;

    const token = this.bridgeToken(session.userId, session.organizationId);
    await firstValueFrom(
      this.http.post(
        `${this.pythonAgentUrl}/call-copilot/index`,
        {
          sessionId: session._id.toString(),
          fullTranscript,
          summaryText,
          recordedAt: (session.endedAt ?? new Date()).toISOString(),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
  }

  /** AI Sales Coach — best-effort, never throws (callers fire this without
   * awaiting before responding to the client, exactly like indexSession
   * above, so it can never add latency to "End Call" or an upload finishing).
   * Public (unlike indexSession) because both call-copilot.gateway.ts (live
   * calls) and call-copilot-upload.service.ts (uploads) call this directly
   * after their own existing summarize step, then emit 'call:coaching'
   * themselves once it resolves — this service is deliberately NOT given a
   * reference to the gateway, since call-copilot.gateway.ts already imports
   * CallCopilotService and the reverse import would be circular. A run
   * already going for this call (the coach button) is left to finish instead. */
  async generateCoaching(session: CallSessionDocument, fullTranscript: string): Promise<CallSessionDocument> {
    if (!fullTranscript.trim()) return session;
    if (!(await this.claimCoachingRun(session))) return session;
    return this.runCoaching(session, fullTranscript);
  }

  /** The "Generate coaching report" button. Starts the review in the
   * background and answers at once: on a long call the review takes over a
   * minute, longer than a proxy keeps a request open (the old synchronous
   * route 502'd on every 10-minute call). A run already going is joined, not
   * paid for twice. The caller waits for coachingGeneratedAt or coachingError
   * to pass `startedAt` on the session. */
  async requestCoaching(session: CallSessionDocument, fullTranscript: string): Promise<{ status: 'generating'; startedAt: Date }> {
    if (coachingInProgress(session)) return { status: 'generating', startedAt: session.coachingStartedAt! };
    if (!(await this.claimCoachingRun(session))) {
      // Someone else (a double click, the automatic run) started one just now.
      const current = await this.sessionModel.findById(session._id).select({ coachingStartedAt: 1 }).exec();
      return { status: 'generating', startedAt: current?.coachingStartedAt ?? new Date() };
    }
    void this.runCoaching(session, fullTranscript).catch((err: Error) =>
      this.logger.warn(`Call copilot coaching crashed for session ${session._id}: ${err.message}`),
    );
    return { status: 'generating', startedAt: session.coachingStartedAt! };
  }

  /** Marks a new coaching run as started — only if nobody else did since this
   * document was read, so two runs never start for the same call. */
  private async claimCoachingRun(session: CallSessionDocument): Promise<boolean> {
    const startedAt = new Date();
    const { modifiedCount } = await this.sessionModel
      .updateOne({ _id: session._id, coachingStartedAt: session.coachingStartedAt ?? null }, { $set: { coachingStartedAt: startedAt }, $unset: { coachingError: '' } })
      .exec();
    if (!modifiedCount) return false;
    // Mirrored on the document, so its own save() later writes the same values.
    session.coachingStartedAt = startedAt;
    session.coachingError = undefined;
    return true;
  }

  /** The review itself. Never throws: a failure is logged and kept on the
   * session in words the coach panel can show. */
  private async runCoaching(session: CallSessionDocument, fullTranscript: string): Promise<CallSessionDocument> {
    try {
      const token = this.bridgeToken(session.userId, session.organizationId);
      const summaryText = [session.headline, ...session.summaryPoints, ...session.keyTakeaways].filter(Boolean).join('\n');
      const { data } = await firstValueFrom(
        this.http.post<{
          categoryScores: { category: string; score: number; rationale: string }[];
          whatWentWell: string[];
          whatToImprove: string[];
          whatWouldHaveDoneDifferently: string[];
          nextCallFocus: string[];
          keyMoments: { momentType: string; text: string; recommendation: string; relatedEventText: string }[];
          coachingSummary: string;
          voiceScript: string;
        }>(
          `${this.pythonAgentUrl}/call-copilot/coach`,
          {
            sessionId: session._id.toString(),
            contextBlob: session.contextBlob ?? '',
            fullTranscript,
            detectedEvents: session.events.map((e) => e.text),
            summary: summaryText,
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: AI_REPORT_TIMEOUT_MS },
        ),
      );

      session.categoryScores = data.categoryScores as never;
      session.overallScore = data.categoryScores.length
        ? Math.round((data.categoryScores.reduce((sum, c) => sum + c.score, 0) / data.categoryScores.length) * 10) / 10
        : undefined;
      session.whatWentWell = data.whatWentWell;
      session.whatToImprove = data.whatToImprove;
      session.whatWouldHaveDoneDifferently = data.whatWouldHaveDoneDifferently;
      session.nextCallFocus = data.nextCallFocus;
      // Match each moment back to a real detected-event timestamp by exact
      // text — the LLM never sees or invents a timestamp itself, only which
      // already-detected signal (if any) a moment corresponds to.
      session.keyMoments = data.keyMoments.map((m) => {
        const matchedEvent = session.events.find((e) => e.text === m.relatedEventText);
        return {
          momentType: m.momentType,
          text: m.text,
          recommendation: m.recommendation,
          occurredAt: matchedEvent?.detectedAt,
        };
      }) as never;
      session.coachingSummary = data.coachingSummary;
      session.voiceScript = data.voiceScript;
      session.voiceScripts = [];
      session.coachingGeneratedAt = new Date();
      await session.save();
    } catch (err) {
      const failure = describeCoachingFailure(err);
      this.logger.warn(`Call copilot coaching failed for session ${session._id}: ${failure.technical}`);
      session.coachingError = failure.message;
      await session.save().catch((saveErr: Error) => this.logger.warn(`Call copilot coaching failure not saved for session ${session._id}: ${saveErr.message}`));
    }
    return session;
  }

  /** The AI Coach's spoken script in the language the user picked. English is
   * the script generateCoaching already produced; any other language is that
   * coaching rewritten natively (not machine-translated word for word) by
   * python-agent's /call-copilot/voice-script, then cached on the session per
   * language so replaying or re-selecting it costs nothing. The caller then
   * speaks it through the existing /voice/speak with the same languageCode. */
  async getVoiceScript(session: CallSessionDocument, languageCode: string): Promise<string> {
    if (!session.voiceScript || session.overallScore === undefined) {
      throw new BadRequestException('This call has no coaching report yet — generate one first.');
    }
    if (languageCode === 'en') return session.voiceScript;

    const cached = session.voiceScripts.find((v) => v.languageCode === languageCode);
    if (cached) return cached.script;

    const token = this.bridgeToken(session.userId, session.organizationId);
    const { data } = await firstValueFrom(
      this.http.post<{ languageCode: string; voiceScript: string }>(
        `${this.pythonAgentUrl}/call-copilot/voice-script`,
        {
          sessionId: session._id.toString(),
          languageCode,
          overallScore: session.overallScore,
          categoryScores: session.categoryScores,
          whatWentWell: session.whatWentWell,
          whatToImprove: session.whatToImprove,
          whatWouldHaveDoneDifferently: session.whatWouldHaveDoneDifferently,
          nextCallFocus: session.nextCallFocus,
          coachingSummary: session.coachingSummary ?? '',
          voiceScript: session.voiceScript,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );

    session.voiceScripts.push({ languageCode, script: data.voiceScript });
    await session.save();
    return data.voiceScript;
  }

  /** A session that errors out (client disconnect mid-call, an unhandled
   * exception) releases its credit hold instead of leaving it pending
   * forever — same reasoning as chat's release() on a failed turn. */
  async errorSession(session: CallSessionDocument, message: string, options: { retryable?: boolean } = {}): Promise<void> {
    session.status = 'error';
    session.errorMessage = message;
    if (options.retryable !== undefined) session.retryable = options.retryable;
    session.endedAt = new Date();
    await session.save();
    try {
      await this.reservations.release(session.creditRequestId);
    } catch (err) {
      this.logger.warn(`Call copilot billing release failed for session ${session._id}: ${(err as Error).message}`);
    }
  }
}
