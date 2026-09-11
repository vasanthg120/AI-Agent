import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UsersService } from '../users/users.service';
import { CallCopilotService } from './call-copilot.service';
import { CallSessionDocument } from './schemas/call-session.schema';

interface AuthedSocket extends Socket {
  data: { user?: JwtPayload; activeSession?: CallSessionDocument };
}

// Deliberately a SEPARATE namespace/gateway from ChatGateway, not new event
// names bolted onto it — zero shared code path with the heavily-used chat
// socket means zero risk of a call-copilot bug affecting chat. Auth in
// handleConnection replicates ChatGateway's manual JWT-verify pattern
// exactly (same session-revocation/active-user checks) since sockets bypass
// Passport/JwtStrategy entirely either way.
@WebSocketGateway({ namespace: '/call-copilot', cors: { origin: true, credentials: true } })
export class CallCopilotGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CallCopilotGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private callCopilotService: CallCopilotService,
    private jwtService: JwtService,
    private usersService: UsersService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      if (payload.purpose) throw new Error('special-purpose token');
      const user = await this.usersService.findById(payload.sub);
      if (!user || user.active === false) throw new Error('inactive or missing user');
      if (!payload.jti || !user.sessions.some((s) => s.jti === payload.jti)) {
        throw new Error('revoked or missing session');
      }
      client.data.user = payload;
    } catch {
      this.logger.warn(`Rejected unauthenticated call-copilot socket ${client.id}`);
      client.emit('call:error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  /** A dropped connection mid-call (network blip, tab closed) never silently
   * discards the call — the session and everything transcribed so far stay
   * in Mongo exactly as they are; the salesperson can resume by reconnecting
   * and calling GET /call-copilot/sessions/:id to resync, or simply End Call
   * later. Nothing is auto-ended here, since a brief disconnect-reconnect
   * during a real customer call must not silently drop a live session. */
  handleDisconnect(client: AuthedSocket) {
    this.logger.debug(`Call-copilot socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('call:start')
  async onStart(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { dealId?: string; contactId?: string; contextQuery?: string },
  ) {
    const user = client.data.user;
    if (!user) {
      client.emit('call:error', { message: 'Unauthorized' });
      return;
    }
    try {
      const session = await this.callCopilotService.startSession(
        user.organizationId,
        user.sub,
        body.dealId,
        body.contactId,
        body.contextQuery || 'sales call',
      );
      client.data.activeSession = session;
      client.emit('call:started', { sessionId: session._id.toString() });
      client.emit('call:contextReady', { contextBlob: session.contextBlob ?? '' });
    } catch (err) {
      this.logger.error(`call:start failed: ${(err as Error).message}`);
      client.emit('call:error', { message: 'Could not start the call session. Please try again.' });
    }
  }

  @SubscribeMessage('call:audioSegment')
  async onAudioSegment(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { sequence: number; audio: Buffer; mimeType: string; languageCode: string },
  ) {
    const session = client.data.activeSession;
    if (!session) {
      client.emit('call:error', { message: 'No active call session.' });
      return;
    }

    try {
      const audioBuffer = Buffer.isBuffer(body.audio) ? body.audio : Buffer.from(body.audio);
      const transcript = await this.callCopilotService.appendAudioSegment(
        session,
        body.sequence,
        audioBuffer,
        body.mimeType,
        body.languageCode,
      );
      if (transcript) {
        client.emit('call:transcript', { sequence: body.sequence, text: transcript });
      }

      // Fire-and-forget from the caller's perspective — the socket handler
      // doesn't block the next segment on this cycle's analysis result, but
      // IS awaited here so a slow Claude call never overlaps with the next
      // one for the SAME session (this handler runs one segment at a time,
      // per Socket.IO's own single-threaded event delivery per socket).
      const result = await this.callCopilotService.maybeAnalyze(session);
      if (!result.skipped) {
        client.emit('call:analysis', {
          sentiment: result.sentiment,
          events: result.events,
          recommendations: result.recommendations,
        });
      }
    } catch (err) {
      // A single bad segment (transcription hiccup, analysis failure) must
      // never tear down the whole call — the salesperson is still live on
      // the phone. Surfaced as a soft warning, not a fatal error.
      this.logger.warn(`call:audioSegment failed for session ${session._id}: ${(err as Error).message}`);
      client.emit('call:warning', { message: 'A moment of audio could not be processed — the call continues.' });
    }
  }

  @SubscribeMessage('call:end')
  async onEnd(@ConnectedSocket() client: AuthedSocket) {
    const session = client.data.activeSession;
    if (!session) {
      client.emit('call:error', { message: 'No active call session.' });
      return;
    }
    try {
      const ended = await this.callCopilotService.endSession(session);
      client.emit('call:summary', {
        summary: ended.summary,
        keyTakeaways: ended.keyTakeaways,
        followUpActions: ended.followUpActions,
      });
    } catch (err) {
      this.logger.error(`call:end failed for session ${session._id}: ${(err as Error).message}`);
      client.emit('call:error', { message: 'Could not finalize the call summary, but your recording was saved.' });
    } finally {
      client.data.activeSession = undefined;
    }
  }
}
