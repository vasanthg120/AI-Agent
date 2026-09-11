import { create } from 'zustand';
import {
  callCopilotService,
  type CallController,
  type CallEvent,
  type CallFollowUpAction,
  type CallRecommendation,
  type StartCallParams,
} from '@/services/callCopilotService';

export type CallStatus = 'idle' | 'starting' | 'recording' | 'ending' | 'ended' | 'error';

interface CallSummaryState {
  summary: string;
  keyTakeaways: string[];
  followUpActions: CallFollowUpAction[];
}

interface CallSessionState {
  status: CallStatus;
  sessionId: string | null;
  contextBlob: string;
  transcript: string;
  events: CallEvent[];
  recommendations: CallRecommendation[];
  sentiment: string | null;
  warning: string | null;
  error: string | null;
  summary: CallSummaryState | null;
  controller: CallController | null;

  startCall: (params: StartCallParams) => void;
  appendAudioSegment: (blob: Blob, sequence: number, languageCode: string) => Promise<void>;
  endCall: () => void;
  reset: () => void;
}

const initialState = {
  status: 'idle' as CallStatus,
  sessionId: null as string | null,
  contextBlob: '',
  transcript: '',
  events: [] as CallEvent[],
  recommendations: [] as CallRecommendation[],
  sentiment: null as string | null,
  warning: null as string | null,
  error: null as string | null,
  summary: null as CallSummaryState | null,
  controller: null as CallController | null,
};

// Mirrors chatStore.ts's shape: plain state fields for a live session, a
// controller stashed after the service call returns, callbacks doing
// immutable `set()` merges as events arrive. One difference from chat: this
// is a single active call at a time (no per-conversation map), matching how
// only one call can realistically be in progress in one browser tab.
export const useCallSessionStore = create<CallSessionState>((set, get) => ({
  ...initialState,

  startCall(params) {
    set({ ...initialState, status: 'starting' });
    const controller = callCopilotService.startCall(params, {
      onStarted: (sessionId) => set({ sessionId, status: 'recording' }),
      onContextReady: (contextBlob) => set({ contextBlob }),
      onTranscript: (_sequence, text) => {
        if (!text) return;
        set((state) => ({ transcript: state.transcript ? `${state.transcript} ${text}` : text }));
      },
      onAnalysis: (result) => {
        set((state) => ({
          sentiment: result.sentiment ?? state.sentiment,
          events: [...state.events, ...result.events],
          recommendations: [...state.recommendations, ...result.recommendations],
        }));
      },
      onSummary: (result) => set({ status: 'ended', summary: result }),
      onWarning: (message) => set({ warning: message }),
      onError: (err) => set({ status: 'error', error: err.message }),
    });
    set({ controller });
  },

  async appendAudioSegment(blob, sequence, languageCode) {
    const { controller, status } = get();
    if (!controller || status !== 'recording') return;
    await controller.sendAudioSegment(blob, sequence, languageCode);
  },

  endCall() {
    const { controller, status } = get();
    if (!controller || (status !== 'recording' && status !== 'starting')) return;
    set({ status: 'ending' });
    controller.end();
  },

  reset() {
    get().controller?.disconnect();
    set({ ...initialState });
  },
}));
