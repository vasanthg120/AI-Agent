import { axiosClient } from '@/api/axiosClient';
import { getCallCopilotSocket } from '@/api/socketClient';
import { useAuthStore } from '@/stores/authStore';

export interface CallTranscriptSegment {
  sequence: number;
  text: string;
  audioFileId: string;
  recordedAt: string;
  speaker?: string;
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
  owner?: 'salesperson' | 'customer';
}

export type CallOutcome = 'moving_forward' | 'needs_follow_up' | 'objection_raised' | 'no_decision' | 'lost' | 'not_applicable';

export interface CallSummaryResult {
  // Legacy paragraph — only ever populated on a session ended before the
  // structured summary shipped. New sessions leave this empty; render the
  // fields below instead, falling back to this when summaryPoints is empty.
  summary?: string;
  headline?: string;
  outcome?: CallOutcome;
  summaryPoints: string[];
  customerNeeds: string[];
  concernsRaised: string[];
  keyTakeaways: string[];
  followUpActions: CallFollowUpAction[];
}

export interface CallSessionDetail extends CallSummaryResult {
  _id: string;
  organizationId: string;
  userId: string;
  dealId?: string;
  contactId?: string;
  status: 'active' | 'processing' | 'ended' | 'error';
  source: 'live' | 'upload';
  originalRecordingFileId?: string;
  originalFilename?: string;
  contextBlob?: string;
  transcript: CallTranscriptSegment[];
  events: CallEvent[];
  recommendations: CallRecommendation[];
  sentiment?: string;
  endedAt?: string;
  createdAt: string;
}

export type CallSessionSummary = Omit<CallSessionDetail, 'transcript'>;

export interface SearchCallSessionsParams {
  q?: string;
  dealId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchCallSessionsResult {
  items: CallSessionSummary[];
  total: number;
  page: number;
  pageSize: number;
  mode: 'browse' | 'search';
}

export interface CallLibraryStats {
  total: number;
  last7Days: number;
  live: number;
  uploaded: number;
  avgSentiment: string | null;
}

export interface StartCallParams {
  dealId?: string;
  contactId?: string;
  contextQuery?: string;
}

export interface UploadRecordingParams {
  dealId?: string;
  contactId?: string;
  languageCode: string;
}

export interface CallCopilotCallbacks {
  onStarted?: (sessionId: string) => void;
  onContextReady: (contextBlob: string) => void;
  onTranscript: (sequence: number, text: string) => void;
  onAnalysis: (result: { sentiment?: string; events: CallEvent[]; recommendations: CallRecommendation[] }) => void;
  onSummary: (result: CallSummaryResult) => void;
  onWarning: (message: string) => void;
  onError: (error: Error) => void;
}

export interface CallController {
  sendAudioSegment: (blob: Blob, sequence: number, languageCode: string) => Promise<void>;
  end: () => void;
  disconnect: () => void;
}

interface SessionScopedPayload {
  sessionId?: string;
}

// Every /call-copilot socket event now carries a sessionId (see
// call-copilot.gateway.ts) — required once uploads can process in the
// background on the SAME socket connection a live call or the library page
// might also be using, so events from unrelated sessions don't cross-wire
// into the wrong UI. subscribeToSession is the shared listener-wiring logic
// both startCall (live) and watchUploadProgress (background upload) build on.
function subscribeToSession(
  sessionId: string,
  callbacks: Omit<CallCopilotCallbacks, 'onStarted'>,
): () => void {
  const token = useAuthStore.getState().accessToken ?? '';
  const socket = getCallCopilotSocket(token);
  if (!socket.connected) socket.connect();

  const matches = (payload: SessionScopedPayload) => payload.sessionId === sessionId;

  const onContextReady = (payload: SessionScopedPayload & { contextBlob: string }) => {
    if (matches(payload)) callbacks.onContextReady(payload.contextBlob);
  };
  const onTranscript = (payload: SessionScopedPayload & { sequence: number; text: string }) => {
    if (matches(payload)) callbacks.onTranscript(payload.sequence, payload.text);
  };
  const onAnalysis = (payload: SessionScopedPayload & { sentiment?: string; events: CallEvent[]; recommendations: CallRecommendation[] }) => {
    if (matches(payload)) callbacks.onAnalysis(payload);
  };
  const onSummary = (payload: SessionScopedPayload & CallSummaryResult) => {
    if (matches(payload)) callbacks.onSummary(payload);
  };
  const onWarning = (payload: SessionScopedPayload & { message: string }) => {
    if (matches(payload)) callbacks.onWarning(payload.message);
  };
  // call:error is emitted both with a sessionId (a specific session's
  // pipeline failed) and without one (e.g. an unauthenticated socket, or "no
  // active session" for a stale client) — the latter has no session to
  // scope against, so every subscriber sees it rather than none.
  const onErrorEvent = (payload: SessionScopedPayload & { message: string }) => {
    if (!payload.sessionId || matches(payload)) callbacks.onError(new Error(payload.message));
  };

  socket.on('call:contextReady', onContextReady);
  socket.on('call:transcript', onTranscript);
  socket.on('call:analysis', onAnalysis);
  socket.on('call:summary', onSummary);
  socket.on('call:warning', onWarning);
  socket.on('call:error', onErrorEvent);

  return () => {
    socket.off('call:contextReady', onContextReady);
    socket.off('call:transcript', onTranscript);
    socket.off('call:analysis', onAnalysis);
    socket.off('call:summary', onSummary);
    socket.off('call:warning', onWarning);
    socket.off('call:error', onErrorEvent);
  };
}

export const callCopilotService = {
  async listSessions(): Promise<CallSessionSummary[]> {
    const { data } = await axiosClient.get<CallSessionSummary[]>('/call-copilot/sessions');
    return data;
  },

  async searchSessions(params: SearchCallSessionsParams): Promise<SearchCallSessionsResult> {
    const { data } = await axiosClient.get<SearchCallSessionsResult>('/call-copilot/sessions/search', { params });
    return data;
  },

  async getStats(): Promise<CallLibraryStats> {
    const { data } = await axiosClient.get<CallLibraryStats>('/call-copilot/sessions/stats');
    return data;
  },

  async getSession(sessionId: string): Promise<CallSessionDetail> {
    const { data } = await axiosClient.get<CallSessionDetail>(`/call-copilot/sessions/${sessionId}`);
    return data;
  },

  // Deliberately NOT a plain URL string for an <audio src="..."> to hit
  // directly — this route sits behind JwtAuthGuard, and a native <audio>/
  // <img> element's browser-issued request carries no Authorization header
  // at all (axiosClient's interceptor is the ONLY thing that attaches the
  // bearer token, and only for requests actually made through axios). Same
  // fix voiceService.speak() already uses for its own protected audio
  // response: fetch via axiosClient with responseType:'blob' (properly
  // authenticated), let the caller turn that into an object URL.
  async getAudioBlob(sessionId: string, fileId: string): Promise<Blob> {
    const { data } = await axiosClient.get(`/call-copilot/sessions/${sessionId}/audio/${fileId}`, { responseType: 'blob' });
    return data as Blob;
  },

  /** Uploads a pre-recorded call; responds once the session is created and
   * background processing has started (NOT once processing finishes — that
   * arrives later via watchUploadProgress on the same socket the live path
   * uses). Multipart, matching every other file-upload service in this app. */
  async uploadRecording(file: File, params: UploadRecordingParams): Promise<{ sessionId: string; status: string }> {
    const form = new FormData();
    form.append('audio', file);
    if (params.dealId) form.append('dealId', params.dealId);
    if (params.contactId) form.append('contactId', params.contactId);
    form.append('languageCode', params.languageCode);
    const { data } = await axiosClient.post<{ sessionId: string; status: string }>('/call-copilot/sessions/upload', form);
    return data;
  },

  /** Subscribes to an upload's background processing progress, for a
   * sessionId already returned by uploadRecording — a known id up front, so
   * (unlike startCall below) there's no call:started race to resolve first. */
  watchUploadProgress(sessionId: string, callbacks: Omit<CallCopilotCallbacks, 'onStarted'>): () => void {
    return subscribeToSession(sessionId, callbacks);
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

    let unsubscribe: (() => void) | null = null;

    const onStarted = (payload: { sessionId: string }) => {
      callbacks.onStarted?.(payload.sessionId);
      // Registered synchronously within this handler — socket.io dispatches
      // queued packets on the same connection strictly in arrival order, so
      // this catches call:contextReady (emitted immediately after
      // call:started server-side) even though it wasn't listening yet when
      // that packet arrived.
      unsubscribe = subscribeToSession(payload.sessionId, callbacks);
    };
    // A fatal call:start failure never carries a sessionId (the session was
    // never created) — always shown, same as subscribeToSession's own
    // unscoped-error handling.
    const onStartError = (payload: { message: string }) => {
      if (!('sessionId' in payload)) callbacks.onError(new Error(payload.message));
    };

    socket.on('call:started', onStarted);
    socket.on('call:error', onStartError);
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
        socket.off('call:started', onStarted);
        socket.off('call:error', onStartError);
        unsubscribe?.();
      },
    };
  },
};
