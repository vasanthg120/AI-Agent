import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GridFsService } from '../common/gridfs/gridfs.service';
import { CallCopilotService } from './call-copilot.service';

// REST is only ever used for resync/history/playback here — the live call
// itself (start/audio/analysis/end) is entirely socket-driven (see
// call-copilot.gateway.ts), same division of labor as chat's
// ChatController (REST for history) vs. ChatGateway (the live turn).
@UseGuards(JwtAuthGuard)
@Controller('call-copilot')
export class CallCopilotController {
  constructor(
    private callCopilotService: CallCopilotService,
    private gridFs: GridFsService,
  ) {}

  @Get('sessions')
  listSessions(@CurrentUser() user: JwtPayload) {
    return this.callCopilotService.listSessions(user.organizationId, user.sub);
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
    if (!session || !session.transcript.some((s) => s.audioFileId === fileId)) {
      throw new NotFoundException('Recording segment not found');
    }
    res.set({ 'Content-Type': 'audio/webm' });
    this.gridFs.openDownloadStream('call_recordings', fileId).pipe(res);
  }
}
