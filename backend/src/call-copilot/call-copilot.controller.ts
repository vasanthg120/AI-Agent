import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CALL_RECORDING_UPLOAD_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CallCopilotUploadService } from './call-copilot-upload.service';
import { CallCopilotService } from './call-copilot.service';
import { CallTeamQueryDto, SearchCallSessionsQueryDto } from './dto/search-call-sessions-query.dto';
import { CallSessionDocument } from './schemas/call-session.schema';
import { TeamScopeService } from '../team-activity/team-scope.service';
import { RetryCallSessionDto } from './dto/retry-call-session.dto';
import { UploadCallRecordingDto } from './dto/upload-call-recording.dto';
import { VoiceScriptDto } from './dto/voice-script.dto';
import { Feature } from '../common/app-features';
import { FeatureGuard } from '../common/guards/feature.guard';
import { Permission } from '../common/permissions/permission.decorator';

// Covers exactly the formats UploadRecordingModal.tsx's file input accepts
// ("audio/*,video/mp4,.m4a") — a small local map rather than pulling in the
// (type-less, in this repo) `mime-types` package for a handful of known
// extensions. Falls back to a generic type Chrome/Firefox/Safari all still
// attempt to play via content-sniffing rather than refusing outright.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function contentTypeFromFilename(filename: string | undefined): string {
  const ext = (filename?.split('.').pop() ?? '').toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// REST is only ever used for resync/history/playback/upload here — the live
// call itself (start/audio/analysis/end) is entirely socket-driven (see
// call-copilot.gateway.ts), same division of labor as chat's
// ChatController (REST for history) vs. ChatGateway (the live turn). Route
// order matters below: every static segment ('sessions/search',
// 'sessions/stats', 'sessions/upload') must be registered BEFORE the
// dynamic 'sessions/:id', same rule business-knowledge-documents.controller.ts's
// own comment documents for its 'query' segment — otherwise Express would
// treat "search"/"stats"/"upload" as an :id value.
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature('call_copilot')
@Permission('call_copilot')
@Controller('call-copilot')
export class CallCopilotController {
  constructor(
    private callCopilotService: CallCopilotService,
    private uploadService: CallCopilotUploadService,
    private gridFs: GridFsService,
    private scopes: TeamScopeService,
  ) {}

  @Get('sessions')
  listSessions(@CurrentUser() user: JwtPayload) {
    return this.callCopilotService.listSessions(user.organizationId, user.sub);
  }

  // Team calls (decided 2026-11-12): an owner or admin sees every call of their
  // business, a manager their store's, and the Main Account owner every
  // business's — the Main Account and each sub-account. Everyone else, as
  // before, only their own. Whose is always worked out here from the caller.
  @Get('team')
  async team(@CurrentUser() user: JwtPayload) {
    const scope = await this.scopes.resolve(user);
    if (!scope.team) return { team: false, acrossBusinesses: false, businesses: [], people: [] };
    const people = await Promise.all(
      scope.businesses.map(async (b) =>
        (await this.scopes.people(scope, b)).map((p) => ({ id: p.id, name: p.mainAccountMember ? `${p.name} (Main Account)` : p.name, businessId: b.id, active: p.active })),
      ),
    );
    return {
      team: true,
      acrossBusinesses: scope.acrossBusinesses,
      businesses: scope.businesses.map((b) => ({ id: b.id, name: b.name, isMain: b.isMain, isCurrent: b.isCurrent })),
      people: people.flat().sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // Powers the Call Library page — browse (paginated, filterable) when `q`
  // is empty, semantic search (ranked top-N, no real pagination) when it's
  // not. A separate endpoint from plain listSessions above, which stays
  // exactly as-is for whatever already calls it. scope=team lists the team's
  // calls instead, each with whose and which business it is.
  @Get('sessions/search')
  async searchSessions(@CurrentUser() user: JwtPayload, @Query() query: SearchCallSessionsQueryDto) {
    if (query.scope === 'team') {
      const team = await this.teamOwners(user, query);
      if (team) {
        const result = await this.callCopilotService.browseTeamSessions(team.match, query);
        return { ...result, items: result.items.map((s) => this.labelled(s, user, team.names, team.businessNames)) };
      }
    }
    return this.callCopilotService.searchSessions(user.organizationId, user.sub, query);
  }

  @Get('sessions/stats')
  async getStats(@CurrentUser() user: JwtPayload, @Query() query: CallTeamQueryDto) {
    if (query.scope === 'team') {
      const team = await this.teamOwners(user, query);
      if (team) return this.callCopilotService.getTeamStats(team.match);
    }
    return this.callCopilotService.getStats(user.organizationId, user.sub);
  }

  /** The filter for the team's calls the caller may see (one business / one person if asked), or null when they only see their own. */
  private async teamOwners(user: JwtPayload, query: CallTeamQueryDto) {
    const scope = await this.scopes.resolve(user);
    if (!scope.team) return null;
    const businesses = this.scopes.pick(scope, query.organizationId);
    const clauses: Record<string, unknown>[] = [];
    const names = new Map<string, string>();
    for (const business of businesses) {
      const people = await this.scopes.people(scope, business);
      for (const p of people) names.set(p.id, p.name);
      const ids = people.map((p) => p.id).filter((id) => !query.userId || id === query.userId);
      if (ids.length) clauses.push({ organizationId: business.id, userId: { $in: ids } });
    }
    // Nobody in reach (a person of another business asked for): a filter that matches nothing.
    const match = clauses.length ? { $or: clauses } : { _id: null };
    return { match, names, businessNames: new Map(businesses.map((b) => [b.id, b.name])) };
  }

  /** A session as the team list shows it: with whose it is and which business, and whether it is the caller's own. */
  private labelled(session: CallSessionDocument, user: JwtPayload, names: Map<string, string>, businessNames: Map<string, string>) {
    const mine = session.organizationId === user.organizationId && session.userId === user.sub;
    return {
      ...session.toJSON(),
      ownerName: names.get(session.userId) ?? 'Former user',
      businessName: businessNames.get(session.organizationId),
      readOnly: !mine,
    };
  }

  /** Someone else's call the caller may open (TeamScopeService.canSee), or null. */
  private async teamSession(user: JwtPayload, id: string): Promise<CallSessionDocument | null> {
    const session = await this.callCopilotService.findSessionById(id);
    if (!session || !(await this.scopes.canSee(user, session.organizationId, session.userId))) return null;
    return session;
  }

  // "Upload a Recording" — processes in the background; responds immediately
  // with the created session so the frontend can show progress via the same
  // /call-copilot socket the live path already uses (see
  // CallCopilotUploadService/CallCopilotGateway.emitToUser).
  @Post('sessions/upload')
  @UseInterceptors(FileInterceptor('audio', CALL_RECORDING_UPLOAD_INTERCEPTOR_OPTIONS))
  async upload(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File, @Body() dto: UploadCallRecordingDto) {
    const session = await this.uploadService.startUploadSession(user.organizationId, user.sub, file, dto);
    return { sessionId: session._id.toString(), status: session.status };
  }

  // Resyncs a client that reconnected mid-call (or just refreshed the page)
  // to the session's current state — same purpose as re-fetching messages
  // after a dropped chat socket.
  @Get('sessions/:id')
  async getSession(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const session = await this.callCopilotService.getSession(user.organizationId, user.sub, id);
    if (session) return session;
    // A teammate's call: shown to read — coaching, "try again" and the spoken
    // coach stay with the person who made it (they bill their business).
    const shared = await this.teamSession(user, id);
    if (!shared) throw new NotFoundException('Call session not found');
    return { ...shared.toJSON(), ...(await this.scopes.describeOwner(shared.organizationId, shared.userId)), readOnly: true };
  }

  // "Try again" on a recording whose transcription failed (Sarvam out of
  // credits, the AI service down, …) — reprocesses the copy already saved in
  // GridFS; responds at once, progress arrives over the socket as for an upload.
  @Post('sessions/:id/retry')
  async retry(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RetryCallSessionDto) {
    const session = await this.uploadService.retryProcessing(user.organizationId, id, { userId: user.sub, languageCode: dto.languageCode });
    return { sessionId: session._id.toString(), status: session.status };
  }

  // "Generate coaching report" — for a call with no report (it ended before
  // the AI Coach existed, or the automatic review failed). Answers 202 at once
  // and reviews in the background: a long call takes over a minute, which a
  // proxy won't hold a request open for. The page then waits on the session's
  // coachingGeneratedAt / coachingError (see requestCoaching).
  @Post('sessions/:id/coach')
  @HttpCode(HttpStatus.ACCEPTED)
  async coach(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const session = await this.callCopilotService.getSession(user.organizationId, user.sub, id);
    if (!session) throw new NotFoundException('Call session not found');
    const fullTranscript = session.transcript
      .map((s) => s.text)
      .filter(Boolean)
      .join(' ');
    // Said up front: with nothing to review the button would seem to do nothing.
    if (!fullTranscript.trim()) {
      throw new BadRequestException(
        session.status === 'error'
          ? 'This call was never transcribed, so there’s nothing for the AI Coach to review.'
          : 'This call has no transcript yet, so there’s nothing for the AI Coach to review.',
      );
    }
    return this.callCopilotService.requestCoaching(session, fullTranscript);
  }

  // The AI Coach's spoken script in the language picked in the panel — the
  // frontend then speaks the returned text via the existing /voice/speak with
  // the same languageCode. Cached per language on the session.
  @Post('sessions/:id/voice-script')
  async voiceScript(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: VoiceScriptDto) {
    const session = await this.callCopilotService.getSession(user.organizationId, user.sub, id);
    if (!session) throw new NotFoundException('Call session not found');
    const voiceScript = await this.callCopilotService.getVoiceScript(session, dto.languageCode);
    return { languageCode: dto.languageCode, voiceScript };
  }

  @Get('sessions/:id/audio/:fileId')
  async streamAudio(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const session = (await this.callCopilotService.getSession(user.organizationId, user.sub, id)) ?? (await this.teamSession(user, id));
    const isKnownFile = fileId === session?.originalRecordingFileId || session?.transcript.some((s) => s.audioFileId === fileId);
    if (!session || !isKnownFile) {
      throw new NotFoundException('Recording segment not found');
    }
    // A live call's segments are always webm (MediaRecorder's own output —
    // see call-copilot.service.ts's appendAudioSegment). An UPLOADED
    // recording can be whatever format the salesperson actually had (MP3,
    // WAV, MP4/M4A — see UploadRecordingModal's accepted file types), so
    // this must reflect the original file's real extension, not assume
    // webm — a browser <audio> element that's told the wrong container type
    // for the actual bytes will refuse to play it.
    const isOriginalUpload = fileId === session.originalRecordingFileId;
    res.set({ 'Content-Type': isOriginalUpload ? contentTypeFromFilename(session.originalFilename) : 'audio/webm' });
    const stream = this.gridFs.openDownloadStream('call_recordings', fileId);
    // A recording that is gone (deleted, or its upload never finished) answers
    // 404 — an unhandled stream error would take the whole server down.
    stream.on('error', () => {
      if (res.headersSent) res.end();
      else res.status(404).type('application/json').send({ statusCode: 404, message: 'Recording not found' });
    });
    stream.pipe(res);
  }
}
