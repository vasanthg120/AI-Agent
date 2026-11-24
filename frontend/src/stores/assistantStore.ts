import { create } from 'zustand';
import type { AiConversationSettings, BriefingView } from '@/services/assistantService';

export type AssistantVoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

const VOICE_ON_KEY = 'haive-assistant-voice-on';

function readVoiceOn(): boolean {
  try {
    return localStorage.getItem(VOICE_ON_KEY) !== 'off';
  } catch {
    return true;
  }
}

interface AssistantState {
  // Today's briefing (once loaded).
  briefing: BriefingView | null;
  // The person's AI Conversations settings (once loaded): voice on/off, language, questions…
  settings: AiConversationSettings | null;
  // Speak replies out loud (the person can mute it).
  voiceOn: boolean;
  voiceState: AssistantVoiceState;
  // What Haive is saying right now (the sentence being spoken), and the sound the window's
  // animation follows: Haive's voice while it speaks, the microphone while it listens.
  caption: string | null;
  voiceStream: MediaStream | null;
  // What the person just asked by voice (shown while Haive works on it).
  heard: string | null;
  // Set when something asks the open window to speak the briefing (the greeting, "Hear it").
  speakBriefingRequest: number;
  // The greeting couldn't play sound on its own (the browser needs a tap first): show "Tap to hear".
  nudge: boolean;
  setBriefing: (briefing: BriefingView | null) => void;
  setSettings: (settings: AiConversationSettings | null) => void;
  setVoiceOn: (on: boolean) => void;
  setVoiceState: (state: AssistantVoiceState) => void;
  setSpeech: (caption: string | null, voiceStream: MediaStream | null) => void;
  setHeard: (heard: string | null) => void;
  requestBriefingSpeech: () => void;
  setNudge: (nudge: boolean) => void;
}

// Shared by the top-bar assistant button, the login greeting and the assistant window.
export const useAssistantStore = create<AssistantState>((set) => ({
  briefing: null,
  settings: null,
  voiceOn: readVoiceOn(),
  voiceState: 'idle',
  caption: null,
  voiceStream: null,
  heard: null,
  speakBriefingRequest: 0,
  nudge: false,
  setBriefing: (briefing) => set({ briefing }),
  setSettings: (settings) => set({ settings }),
  setVoiceOn: (on) => {
    try {
      localStorage.setItem(VOICE_ON_KEY, on ? 'on' : 'off');
    } catch {
      // Storage unavailable: the choice still holds for this visit.
    }
    set({ voiceOn: on });
  },
  setVoiceState: (voiceState) => set({ voiceState }),
  setSpeech: (caption, voiceStream) => set({ caption, voiceStream }),
  setHeard: (heard) => set({ heard }),
  requestBriefingSpeech: () => set((s) => ({ speakBriefingRequest: s.speakBriefingRequest + 1, nudge: false })),
  setNudge: (nudge) => set({ nudge }),
}));
