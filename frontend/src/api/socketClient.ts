import { io, type Socket } from 'socket.io-client';
import { env } from '@/config/env';

let socket: Socket | null = null;

/**
 * Lazily creates the Socket.io connection. Phase 1 chat runs on the mock
 * streaming service (src/services/mock/chatService.ts) and never calls this,
 * but the client is wired and ready for Phase 2 to swap in against the real
 * NestJS `/chat` gateway (same event contract as the previous integration:
 * connect/disconnect/typing/message/error).
 */
export function getSocket(token: string): Socket {
  if (socket) return socket;
  socket = io(`${env.socketUrl}/chat`, { auth: { token }, autoConnect: false });
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

// A separate socket/namespace for the Call Copilot (backend/src/call-copilot's
// own CallCopilotGateway) — deliberately its own connection, not new event
// names on the `/chat` socket above, so a call-copilot issue can never touch
// the chat socket's stability. Same lazy-singleton/autoConnect:false shape.
let callCopilotSocket: Socket | null = null;

export function getCallCopilotSocket(token: string): Socket {
  if (callCopilotSocket) return callCopilotSocket;
  callCopilotSocket = io(`${env.socketUrl}/call-copilot`, { auth: { token }, autoConnect: false });
  return callCopilotSocket;
}

export function disconnectCallCopilotSocket(): void {
  callCopilotSocket?.disconnect();
  callCopilotSocket = null;
}
