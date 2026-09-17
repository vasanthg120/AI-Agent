import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CALL_RECORDING_UPLOAD_INTERCEPTOR_OPTIONS } from '../common/upload-limits';
import { CallCopilotUploadService } from './call-copilot-upload.service';
import { CallCopilotService } from './call-copilot.service';
import { SearchCallSessionsQueryDto } from './dto/search-call-sessions-query.dto';
import { UploadCallRecordingDto } from './dto/upload-call-recording.dto';

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
@UseGuards(JwtAuthGuard)
@Controller('call-copilot')
export class CallCopilotController {
  constructor(
    private callCopilotService: CallCopilotService,
    private uploadService: CallCopilotUploadService,
    private gridFs: GridFsService,
  ) {}

  @Get('sessions')
  listSessions(@CurrentUser() user: JwtPayload) {
    return this.callCopilotService.listSessions(user.organizationId, user.sub);
  }

  // Powers the Call Library page — browse (paginated, filterable) when `q`
  // is empty, semantic search (ranked top-N, no real pagination) when it's
  // not. A separate endpoint from plain listSessions above, which stays
  // exactly as-is for whatever already calls it.
  @Get('sessions/search')
  searchSessions(@CurrentUser() user: JwtPayload, @Query() query: SearchCallSessionsQueryDto) {
    return this.callCopilotService.searchSessions(user.organizationId, user.sub, query);
  }

  @Get('sessions/stats')
  getStats(@CurrentUser() user: JwtPayload) {
    return this.callCopilotService.getStats(user.organizationId, user.sub);
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
    if (!session) throw new NotFoundException('Call session not found');
    return session;
  }

  @Get('sessions/:id/audio/:fileId')
  async streamAudio(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const session = await this.callCopilotService.getSession(user.organizationId, user.sub, id);
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
    this.gridFs.openDownloadStream('call_recordings', fileId).pipe(res);
  }
}
