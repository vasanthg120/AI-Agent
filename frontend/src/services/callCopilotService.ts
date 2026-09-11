import { axiosClient } from '@/api/axiosClient';
import { getCallCopilotSocket } from '@/api/socketClient';
import { useAuthStore } from '@/stores/authStore';

export interface CallTranscriptSegment {
  sequence: number;
  text: string;
  audioFileId: string;
  recordedAt: string;
}

export interface CallEvent {
  type: 'intent' | 'requirement' | 'objection' | 'pain_point' | 'competitor' | 'budget' | 'timeline' | 'buying_signal' | 'commitment';
  text: string;
  detectedAt?: string;
}

export interface CallRecommendation {
  type: 'say' | 'ask' | 'handle_objection' | 'next_action';
  text: string;
  createdAt?: string;
}

export interface CallFollowUpAction {
  text: string;
  priority: 'high' | 'medium' | 'low';
}

export interface CallSessionDetail {
  _id: string;
  organizationId: string;
  userId: string;
  dealId?: string;
  contactId?: string;
  status: 'active' | 'ended' | 'error';
  contextBlob?: string;
  transcript: CallTranscriptSegment[];
  events: CallEvent[];
  recommendations: CallRecommendation[];
  sentiment?: string;
  summary?: string;
  keyTakeaways: string[];
  followUpActions: CallFollowUpAction[];
  endedAt?: string;
  createdAt: string;
}

export type CallSessionSummary = Omit<CallSessionDetail, 'transcript'>;

export interface StartCallParams {
  dealId?: string;
  contactId?: string;
  contextQuery?: string;
}

export interface CallCopilotCallbacks {
  onStarted: (sessionId: string) => void;
  onContextReady: (contextBlob: string) => void;
  onTranscript: (sequence: number, text: string) => void;
  onAnalysis: (result: { sentiment?: string; events: CallEvent[]; recommendations: CallRecommendation[] }) => void;
  onSummary: (result: { summary: string; keyTakeaways: string[]; followUpActions: CallFollowUpAction[] }) => void;
  onWarning: (message: string) => void;
  onError: (error: Error) => void;
}

export interface CallController {
  sendAudioSegment: (blob: Blob, sequence: number, languageCode: string) => Promise<void>;
  end: () => void;
  disconnect: () => void;
}

export const callCopilotService = {
  async listSessions(): Promise<CallSessionSummary[]> {
    const { data } = await axiosClient.get<CallSessionSummary[]>('/call-copilot/sessions');
    return data;
  },

  async getSession(sessionId: string): Promise<CallSessionDetail> {
    const { data } = await axiosClient.get<CallSessionDetail>(`/call-copilot/sessions/${sessionId}`);
    return data;
  },

  audioUrl(sessionId: string, fileId: string): string {
    return `${axiosClient.defaults.baseURL}/call-copilot/sessions/${sessionId}/audio/${fileId}`;
  },

  /** Opens the /call-copilot socket, starts a session, and returns a
   * controller for sending audio segments and ending the call — mirrors
   * chatService.streamReply's shape (a socket wrapped in a small imperative
   * controller) but for a whole call session's lifetime instead of one
   * turn. */
  startCall(params: StartCallParams, callbacks: CallCopilotCallbacks): CallController {
    const token = useAuthStore.getState().accessToken ?? '';
    const socket = getCallCopilotSocket(token);
    if (!socket.connected) socket.connect();

    let sessionId: string | null = null;

    const onStarted = (payload: { sessionId: string }) => {
      sessionId = payload.sessionId;
      callbacks.onStarted(payload.sessionId);
    };
    const onContextReady = (payload: { contextBlob: string }) => callbacks.onContextReady(payload.contextBlob);
    const onTranscript = (payload: { sequence: number; text: string }) => callbacks.onTranscript(payload.sequence, payload.text);
    const onAnalysis = (payload: { sentiment?: string; events: CallEvent[]; recommendations: CallRecommendation[] }) =>
      callbacks.onAnalysis(payload);
    const onSummary = (payload: { summary: string; keyTakeaways: string[]; followUpActions: CallFollowUpAction[] }) =>
      callbacks.onSummary(payload);
    const onWarning = (payload: { message: string }) => callbacks.onWarning(payload.message);
    const onErrorEvent = (payload: { message: string }) => callbacks.onError(new Error(payload.message));

    function cleanup() {
      socket.off('call:started', onStarted);
      socket.off('call:contextReady', onContextReady);
      socket.off('call:transcript', onTranscript);
      socket.off('call:analysis', onAnalysis);
      socket.off('call:summary', onSummary);
      socket.off('call:warning', onWarning);
      socket.off('call:error', onErrorEvent);
    }

    socket.on('call:started', onStarted);
    socket.on('call:contextReady', onContextReady);
    socket.on('call:transcript', onTranscript);
    socket.on('call:analysis', onAnalysis);
    socket.on('call:summary', onSummary);
    socket.on('call:warning', onWarning);
    socket.on('call:error', onErrorEvent);

    socket.emit('call:start', params);

    return {
      async sendAudioSegment(blob: Blob, sequence: number, languageCode: string) {
        const buffer = await blob.arrayBuffer();
        socket.emit('call:audioSegment', {
          sequence,
          audio: buffer,
          mimeType: blob.type || 'audio/webm',
          languageCode,
        });
      },
      end() {
        socket.emit('call:end');
      },
      disconnect() {
        cleanup();
      },
    };
  },
};
