import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

// Socket.IO's own default maxHttpBufferSize is 1MB — fine for the plain
// {message, conversationId, agentId} payloads ChatGateway handled before
// chat attachments existed, but far too small for a base64-encoded file
// attached to a message (see upload-limits.ts's CHAT_ATTACHMENT_MAX_TOTAL_BYTES):
// any larger frame is silently rejected and the socket is disconnected,
// with nothing in ChatGateway ever seeing the message. 30MB comfortably
// clears the ~27MB a maxed-out attachment payload reaches after base64
// inflation plus JSON framing, without raising it so far that one connection
// could buffer an unreasonable amount of memory server-side.
const MAX_HTTP_BUFFER_SIZE_BYTES = 30 * 1024 * 1024;

export class SocketIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, { ...options, maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE_BYTES });
  }
}
