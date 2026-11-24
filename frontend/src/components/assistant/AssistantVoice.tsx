import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ROUTES } from '@/constants/routes';
import { assistantService, type BriefingAction } from '@/services/assistantService';
import { voiceService } from '@/services/voiceService';
import { useAssistantStore } from '@/stores/assistantStore';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { extractErrorMessage } from '@/utils/errors';
import { streamOfElement } from '@/components/voice/useAudioFrames';
import { listen, MicrophoneError, type Listening } from './voice/listen';
import { SpeechQueue } from './voice/speechQueue';

// The language Haive listens and speaks in: the person's AI Conversations setting
// (until it loads, the chat voice input's remembered choice).
const LANGUAGE_KEY = 'haive-voice-language';
function voiceLanguage(): string {
  const fromSettings = useAssistantStore.getState().settings?.language;
  if (fromSettings) return fromSettings;
  try {
    return localStorage.getItem(LANGUAGE_KEY) || 'en';
  } catch {
    return 'en';
  }
}

/** Haive may speak: voice is on in AI Conversations settings and not muted. */
function maySpeak(): boolean {
  const { voiceOn, settings } = useAssistantStore.getState();
  return voiceOn && settings?.voiceEnabled !== false;
}

// One speech queue and one microphone for the whole app.
let queue: SpeechQueue | null = null;
let listening: Listening | null = null;
// The next assistant reply in this conversation is spoken (a question asked by voice, or in the assistant window).
let speakNextReplyIn: string | null = null;
// Notification links already opened (an effect can run twice for the same page visit).
const openedReachOuts = new Set<string>();

function speech(): SpeechQueue {
  if (!queue) {
    queue = new SpeechQueue(
      voiceLanguage,
      (speaking) => {
        const store = useAssistantStore.getState();
        if (speaking) store.setVoiceState('speaking');
        // Caught up with an answer that is still being written: thinking until its next sentence, not done.
        else if (store.voiceState === 'speaking') store.setVoiceState(speakNextReplyIn ? 'thinking' : 'idle');
      },
      (message) => toast.error(message, { id: 'assistant-speech' }),
      // Each sentence as it plays: its words for the caption, its sound for the animation.
      (text, audio) => useAssistantStore.getState().setSpeech(text, audio ? streamOfElement(audio) : null),
    );
  }
  return queue;
}

/** What the assistant window and the greeting can ask for. */
export const assistantVoice = {
  /** Speaks today's briefing (from its conversation), and remembers it was heard. */
  speakBriefing() {
    const { briefing } = useAssistantStore.getState();
    if (!briefing) return;
    speech().stop();
    if (maySpeak()) speech().say(briefing.briefing.spoken);
    if (!briefing.spokenAt) {
      useAssistantStore.getState().setBriefing({ ...briefing, shouldSpeak: false, spokenAt: new Date().toISOString() });
      void assistantService.markSpoken(briefing.id).catch(() => undefined);
    }
  },

  stopSpeaking() {
    speech().stop();
  },

  /** Today's briefing, spoken where the person is (the voice dock in the corner shows it) — the window stays closed. */
  async hearBriefing() {
    await openBriefing(true);
  },

  /** Today's briefing in the Haive window, to read (and act on) — without speaking it again. */
  async showBriefing() {
    await openBriefing(false, false);
  },

  /** "Brief me" when the briefing isn't prepared on sign-in (AI Conversations settings): written now, opened and spoken. */
  async briefMe(queryClient: QueryClient) {
    const briefing = await assistantService.getBriefing();
    queryClient.setQueryData(['assistant-briefing'], briefing);
    useAssistantStore.getState().setBriefing(briefing);
    if (briefing.conversationId) await useChatStore.getState().selectConversation(briefing.conversationId);
    assistantVoice.speakBriefing();
  },

  /** The next reply in this conversation is spoken (if voice is on). */
  armReply(conversationId: string | null) {
    speakNextReplyIn = conversationId ?? '__new__';
  },

  /**
   * Tap to talk. Tapping while Haive speaks interrupts it and listens; tapping
   * while listening finishes. What's said is transcribed and asked in the
   * current conversation, and the answer is spoken as it arrives.
   */
  async talk(onLevel?: (level: number) => void) {
    const store = useAssistantStore.getState();
    if (listening) {
      listening.stop();
      return;
    }
    speech().stop();
    store.setHeard(null);
    try {
      listening = await listen(onLevel);
    } catch (err) {
      store.setVoiceState('idle');
      toast.error(err instanceof MicrophoneError ? err.message : extractErrorMessage(err), { id: 'assistant-mic' });
      return;
    }
    store.setVoiceState('listening');
    // While it listens, the window's animation follows the microphone.
    store.setSpeech(null, listening.stream);
    const blob = await listening.result;
    listening = null;
    useAssistantStore.getState().setSpeech(null, null);
    if (!blob) {
      useAssistantStore.getState().setVoiceState('idle');
      return;
    }
    useAssistantStore.getState().setVoiceState('transcribing');
    try {
      const { transcript } = await voiceService.transcribe(blob, voiceLanguage());
      if (!transcript.trim()) {
        useAssistantStore.getState().setVoiceState('idle');
        toast('Haive didn’t catch that — try again.', { id: 'assistant-mic' });
        return;
      }
      useAssistantStore.getState().setHeard(transcript.trim());
      const chat = useChatStore.getState();
      // Haive asked "Shall I…?" — a yes or a no answers its suggestion, not the chat.
      const pending = pendingAction(chat.activeConversationId);
      const answer = pending ? yesOrNo(transcript) : null;
      if (pending && answer) {
        useAssistantStore.getState().setVoiceState('idle');
        await (answer === 'yes' ? assistantVoice.runAction(pending.id) : assistantVoice.dismissAction(pending.id));
        return;
      }
      assistantVoice.armReply(chat.activeConversationId);
      useAssistantStore.getState().setVoiceState('thinking');
      await chat.sendMessage(transcript, chat.activeAgentId ?? undefined);
    } catch (err) {
      useAssistantStore.getState().setVoiceState('idle');
      toast.error(extractErrorMessage(err), { id: 'assistant-mic' });
    }
  },

  cancelListening() {
    listening?.cancel();
    listening = null;
  },

  /**
   * "Do it" (a tap, or "yes"): the server does what it stored for this suggestion. Haive
   * says it's done only when the server says so; if it fails, the reason is shown and it
   * can be tried again.
   */
  async runAction(actionId: string): Promise<void> {
    const { briefing } = useAssistantStore.getState();
    if (!briefing) return;
    setAction(actionId, { status: 'running', error: undefined });
    try {
      const done = await assistantService.runAction(briefing.id, actionId);
      setAction(actionId, done);
      if (maySpeak() && done.result) {
        speech().stop();
        speech().say(`Done. ${done.result}`);
      }
    } catch (err) {
      const message = extractErrorMessage(err);
      setAction(actionId, { status: 'suggested', error: message });
      toast.error(message, { id: 'assistant-action' });
    }
  },

  /** "Not now". */
  async dismissAction(actionId: string): Promise<void> {
    const { briefing } = useAssistantStore.getState();
    if (!briefing) return;
    setAction(actionId, { status: 'dismissed' });
    try {
      setAction(actionId, await assistantService.dismissAction(briefing.id, actionId));
      if (maySpeak()) speech().say('Okay, not now.');
    } catch {
      // Only put aside on this screen; it stays offered on the server.
    }
  },
};

/** The suggestion Haive is waiting on in this conversation (the briefing's first one still offered). */
function pendingAction(conversationId: string | null): BriefingAction | null {
  const { briefing } = useAssistantStore.getState();
  if (!briefing || !conversationId || briefing.conversationId !== conversationId) return null;
  return briefing.briefing.actions?.find((a) => a.status === 'suggested') ?? null;
}

function setAction(actionId: string, patch: Partial<BriefingAction>) {
  const { briefing, setBriefing } = useAssistantStore.getState();
  if (!briefing) return;
  setBriefing({ ...briefing, briefing: { ...briefing.briefing, actions: briefing.briefing.actions.map((a) => (a.id === actionId ? { ...a, ...patch } : a)) } });
}

// A short spoken yes or no, in the languages Haive speaks (anything longer is a question for the chat).
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|please|haan|haa|ha ji|haan ji|ji haan|aama|aamam|sari|avunu|howdu|ho|hoy)\b/;
const NO = /^(no|nope|not now|don'?t|do not|later|nahi|nahin|na|illa|illai|vendam|venda|kaadu|beda|nako)\b/;

/** "yes" / "no" for a short reply, else null. */
export function yesOrNo(transcript: string): 'yes' | 'no' | null {
  const said = transcript
    .toLowerCase()
    .replace(/[.,!?।'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!said || said.split(' ').length > 6) return null;
  if (NO.test(said)) return 'no';
  if (YES.test(said)) return 'yes';
  return null;
}

/** Where a finished sentence ends in text that is still arriving (a full stop, a question mark, a paragraph). */
function lastBoundary(text: string, from: number): number {
  let end = -1;
  const re = /[.!?।](?=\s)|\n\s*\n/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) end = m.index + m[0].length;
  return end;
}

// Haive's voice, for the whole app: greets once a day with the briefing (the
// person's choice: the first sign-in of the day), speaks replies to what is
// asked by voice or in the assistant window as they arrive, sentence by
// sentence, and shows "Tap to hear" when the browser won't play sound before a
// tap. Mounted once in the app shell.
export function AssistantVoice() {
  const location = useLocation();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const greeted = useRef(false);

  // The person's AI Conversations settings decide whether the briefing is prepared on sign-in, and in what language.
  const settingsQuery = useQuery({
    queryKey: ['assistant-settings'],
    queryFn: assistantService.getSettings,
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const settings = settingsQuery.data?.settings;
  // Settings that can't be read fall back to Haive's standard behaviour (the briefing is prepared).
  const prepareBriefing = settingsQuery.isSuccess ? settings?.briefingEnabled !== false : settingsQuery.isError;

  useEffect(() => {
    useAssistantStore.getState().setSettings(settings ?? null);
    // Voice switched off in settings: stop talking at once.
    if (settings?.voiceEnabled === false) speech().stop();
  }, [settings]);

  const { data } = useQuery({
    queryKey: ['assistant-briefing'],
    queryFn: () => assistantService.getBriefing(),
    enabled: isAuthenticated && prepareBriefing,
    staleTime: 15 * 60_000,
    retry: false,
  });

  useEffect(() => {
    // A briefing Haive reached out with stays on show until it's replaced on purpose.
    if (data && !useAssistantStore.getState().briefing?.label) useAssistantStore.getState().setBriefing(data);
  }, [data]);

  // Opened from a notification (the bell, or a push on the phone): ?haive=<slot> opens Haive on that
  // briefing — written now by the AI, leading with why it reached out.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const slot = params.get('haive');
    if (!slot || !isAuthenticated || openedReachOuts.has(`${location.key}|${slot}`)) return;
    openedReachOuts.add(`${location.key}|${slot}`);
    params.delete('haive');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
    // This visit is about the reach-out: the sign-in greeting doesn't also open.
    greeted.current = true;
    const onChat = location.pathname.startsWith(ROUTES.chat);
    void (async () => {
      toast.loading('Haive is preparing your briefing…', { id: 'assistant-reach-out' });
      try {
        const view = await assistantService.getBriefing(false, slot);
        useAssistantStore.getState().setBriefing(view);
        toast.dismiss('assistant-reach-out');
        await openBriefing(onChat, canPlaySound());
      } catch (err) {
        toast.error(extractErrorMessage(err), { id: 'assistant-reach-out' });
      }
    })();
  }, [location.search, location.pathname, location.key, isAuthenticated, navigate]);

  // The greeting: once a day (the briefing remembers when it was heard).
  useEffect(() => {
    if (!data || greeted.current || !data.shouldSpeak) return;
    greeted.current = true;
    if (!canPlaySound()) {
      useAssistantStore.getState().setNudge(true);
      return;
    }
    void openBriefing(true);
  }, [data, location.pathname]);

  // Speaks the replies it was asked to, as they arrive.
  useEffect(() => {
    let spoken: { key: string; upTo: number } | null = null;
    let seen = new Set<string>();
    const known = (conv: string, count: number) => {
      seen = new Set(Array.from({ length: count }, (_, i) => `${conv}:${i}`));
    };
    const start = useChatStore.getState();
    if (start.activeConversationId) known(start.activeConversationId, (start.messages[start.activeConversationId] ?? []).length);

    return useChatStore.subscribe((state) => {
      const conv = state.activeConversationId;
      if (!conv) return;
      const messages = state.messages[conv] ?? [];
      // Something asked in the open assistant window gets a spoken answer too.
      const panelOpen = useUiStore.getState().assistantPanelOpen;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserKey = lastUser ? `${conv}:${messages.lastIndexOf(lastUser)}` : '';
      if (panelOpen && lastUser && !seen.has(lastUserKey)) {
        seen.add(lastUserKey);
        speakNextReplyIn = conv;
      }
      if (speakNextReplyIn === '__new__') speakNextReplyIn = conv;

      const index = messages.length - 1;
      const last = messages[index];
      const key = `${conv}:${index}`;
      if (!last || last.role !== 'assistant' || seen.has(key)) return;
      if (speakNextReplyIn !== conv || !maySpeak()) {
        if (last.status !== 'streaming' && last.status !== 'pending') {
          seen.add(key);
          // Asked by voice with Haive muted: the answer is written, not spoken — and it's done.
          if (speakNextReplyIn === conv) {
            speakNextReplyIn = null;
            const store = useAssistantStore.getState();
            if (store.voiceState === 'thinking') store.setVoiceState('idle');
          }
        }
        return;
      }
      if (!spoken || spoken.key !== key) spoken = { key, upTo: 0 };
      const done = last.status !== 'streaming' && last.status !== 'pending';
      const upTo = done ? last.content.length : lastBoundary(last.content, spoken.upTo);
      if (upTo > spoken.upTo) {
        speech().say(last.content.slice(spoken.upTo, upTo));
        spoken.upTo = upTo;
      }
      if (done) {
        seen.add(key);
        spoken = null;
        speakNextReplyIn = null;
        const store = useAssistantStore.getState();
        if (store.voiceState === 'thinking' && !speech().speaking) store.setVoiceState('idle');
      }
    });
  }, []);

  // Never leave the microphone on or Haive talking after signing out.
  useEffect(() => {
    if (!isAuthenticated) {
      speech().stop();
      assistantVoice.cancelListening();
    }
  }, [isAuthenticated]);

  // The briefing nudge ("Your briefing is ready — Hear it") is shown by the voice dock, with the mic.
  return null;
}

/** Sound is only allowed after the person has clicked or typed on the page (a sign-in click counts). */
function canPlaySound(): boolean {
  return (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false;
}

/** Opens the briefing in the store — in the assistant window, or in the chat when that's the page — and speaks it (when it can). */
async function openBriefing(onChatPage: boolean, speak = true) {
  const { briefing } = useAssistantStore.getState();
  if (!briefing) return;
  useAssistantStore.getState().setNudge(false);
  if (briefing.conversationId) await useChatStore.getState().selectConversation(briefing.conversationId);
  if (!onChatPage) useUiStore.getState().setAssistantPanelOpen(true);
  if (speak) assistantVoice.speakBriefing();
}
