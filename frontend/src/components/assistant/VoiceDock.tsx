import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { FiMic, FiSquare, FiVolume2, FiX } from 'react-icons/fi';
import { ROUTES } from '@/constants/routes';
import { VoiceOrb, type VoiceOrbState } from '@/components/voice/VoiceOrb';
import { VoiceWaveform } from '@/components/voice/VoiceWaveform';
import { useAudioFrames } from '@/components/voice/useAudioFrames';
import { useAssistantStore, type AssistantVoiceState } from '@/stores/assistantStore';
import { useCallSessionStore } from '@/stores/callSessionStore';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { assistantVoice } from './AssistantVoice';
import { speakable } from './voice/speechQueue';
import styles from './VoiceDock.module.css';

const ORB: Record<AssistantVoiceState, VoiceOrbState> = {
  idle: 'idle',
  listening: 'listening',
  transcribing: 'thinking',
  thinking: 'thinking',
  speaking: 'speaking',
};

const EYEBROW: Record<AssistantVoiceState, string> = {
  idle: 'Haive',
  listening: 'Listening',
  transcribing: 'Got it',
  thinking: 'Thinking',
  speaking: 'Haive',
};

const FAB_LABEL: Record<AssistantVoiceState, string> = {
  idle: 'Talk to Haive',
  listening: 'Finish speaking',
  transcribing: 'Haive is working on it',
  thinking: 'Haive is working on it',
  speaking: 'Interrupt and speak',
};

// How long the answer stays in the corner once Haive has finished.
const LINGER_MS = 9000;

// Haive's voice, in the bottom-right corner of every page: a mic you tap to talk, and the
// place where the conversation comes to life — it listens (the ring follows your voice), it
// thinks (what you asked, while it works), it answers out loud (its avatar and waveform move
// with its own voice, the sentence being said as a caption), then leaves the answer there
// for a moment with a way into the full conversation. The briefing nudge lives here too.
// Out of the way when the Haive window is open (it has its own), during a live call (the
// microphone is the call's) and when voice is switched off in AI Conversations.
export function VoiceDock() {
  const location = useLocation();
  const voiceState = useAssistantStore((s) => s.voiceState);
  const caption = useAssistantStore((s) => s.caption);
  const heard = useAssistantStore((s) => s.heard);
  const stream = useAssistantStore((s) => s.voiceStream);
  const nudge = useAssistantStore((s) => s.nudge);
  const briefing = useAssistantStore((s) => s.briefing);
  const voiceEnabled = useAssistantStore((s) => s.settings?.voiceEnabled !== false);
  const panelOpen = useUiStore((s) => s.assistantPanelOpen);
  const callStatus = useCallSessionStore((s) => s.status);
  const onCall = callStatus === 'starting' || callStatus === 'recording' || callStatus === 'ending';
  const hidden = panelOpen || onCall || !voiceEnabled;
  const onChatPage = location.pathname.startsWith(ROUTES.chat);

  // The answer, left in the corner for a moment once Haive is done.
  const [answer, setAnswer] = useState<{ text: string; briefing: boolean } | null>(null);
  const previous = useRef(voiceState);
  useEffect(() => {
    const was = previous.current;
    previous.current = voiceState;
    if (voiceState !== 'idle') {
      setAnswer(null);
      return;
    }
    if (was !== 'thinking' && was !== 'speaking') return;
    const chat = useChatStore.getState();
    const conversation = chat.activeConversationId;
    const last = conversation ? [...(chat.messages[conversation] ?? [])].reverse().find((m) => m.role === 'assistant') : undefined;
    const text = last ? speakable(last.content) : '';
    if (!text) return;
    // "Your briefing" only when what was said is the briefing itself (a question asked on top of it is an answer).
    const isBriefing = !!briefing && last?.content.trim() === briefing.briefing.spoken.trim();
    setAnswer({ text: text.length > 240 ? `${text.slice(0, 237)}…` : text, briefing: isBriefing });
    const timer = setTimeout(() => setAnswer(null), LINGER_MS);
    return () => clearTimeout(timer);
  }, [voiceState, briefing]);

  // The button's ring follows the voice it hears, or Haive's own.
  const fab = useRef<HTMLButtonElement | null>(null);
  useAudioFrames(
    voiceState === 'listening' || voiceState === 'speaking' ? stream : null,
    (level) => fab.current?.style.setProperty('--level', level.toFixed(3)),
    () => fab.current?.style.setProperty('--level', '0'),
  );

  // Esc puts a lingering answer or the nudge away.
  useEffect(() => {
    if (!answer && !nudge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAnswer(null);
      useAssistantStore.getState().setNudge(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer, nudge]);

  const tap = async () => {
    setAnswer(null);
    useAssistantStore.getState().setNudge(false);
    const chat = useChatStore.getState();
    // Nothing open: a question asked here continues today's briefing (Haive has it as context).
    if (voiceState === 'idle' && !chat.activeConversationId && briefing?.conversationId) await chat.selectConversation(briefing.conversationId);
    void assistantVoice.talk();
  };

  const openConversation = () => {
    setAnswer(null);
    useUiStore.getState().setAssistantPanelOpen(true);
  };

  const mode: 'voice' | 'answer' | 'nudge' | null =
    voiceState !== 'idle' ? 'voice' : answer ? 'answer' : nudge && briefing ? 'nudge' : null;
  const orb = ORB[voiceState];
  const busy = voiceState === 'transcribing' || voiceState === 'thinking';

  return (
    <AnimatePresence>
      {!hidden && (
        <motion.div
          key="dock"
          className={clsx(styles.dock, onChatPage && styles.lifted)}
          initial={{ opacity: 0, y: 16, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
          <AnimatePresence mode="wait">
            {mode && (
              <motion.section
                key={mode}
                className={styles.card}
                data-mode={mode === 'voice' ? orb : mode}
                role="status"
                aria-live="polite"
                aria-label="Haive"
                initial={{ opacity: 0, y: 14, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              >
                <span className={styles.aura} aria-hidden />
                <div className={styles.head}>
                  <VoiceOrb state={mode === 'voice' ? orb : 'idle'} stream={mode === 'voice' && (orb === 'listening' || orb === 'speaking') ? stream : null} size={44} />
                  <div className={styles.headText}>
                    <span className={styles.eyebrow}>
                      <i className={styles.eyebrowDot} aria-hidden />
                      {mode === 'voice' ? EYEBROW[voiceState] : mode === 'answer' ? (answer?.briefing ? 'Your briefing' : 'Answered') : 'Your briefing is ready'}
                    </span>
                    {mode === 'voice' && (orb === 'listening' || orb === 'speaking') && (
                      <VoiceWaveform stream={stream} active={orb === 'speaking'} bars={30} size="sm" tone={orb === 'listening' ? 'danger' : 'accent'} className={styles.wave} />
                    )}
                    {mode === 'voice' && busy && <span className={styles.shimmer} aria-hidden />}
                  </div>
                  {mode !== 'voice' && (
                    <button
                      type="button"
                      className={styles.close}
                      aria-label={mode === 'nudge' ? 'Not now' : 'Close'}
                      onClick={() => (mode === 'nudge' ? useAssistantStore.getState().setNudge(false) : setAnswer(null))}
                    >
                      <FiX aria-hidden />
                    </button>
                  )}
                </div>

                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={`${mode}-${voiceState}-${caption ?? ''}-${heard ?? ''}`}
                    className={clsx(styles.text, mode === 'voice' && voiceState === 'speaking' && styles.spoken)}
                    initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {mode === 'nudge' && briefing?.briefing.headline}
                    {mode === 'answer' && answer?.text}
                    {mode === 'voice' && voiceState === 'listening' && 'Go ahead — ask about today’s revenue, your pipeline, quotes, anything.'}
                    {mode === 'voice' && voiceState === 'transcribing' && 'One moment…'}
                    {mode === 'voice' && voiceState === 'thinking' && (heard ? <>“{heard}”</> : 'Working it out from your own figures…')}
                    {mode === 'voice' && voiceState === 'speaking' && (caption ?? '…')}
                  </motion.p>
                </AnimatePresence>

                <div className={styles.actions}>
                  {mode === 'nudge' && (
                    <>
                      <button type="button" className={styles.primary} onClick={() => void assistantVoice.hearBriefing()}>
                        <FiVolume2 aria-hidden /> Hear it
                      </button>
                      <button type="button" className={styles.ghost} onClick={() => void assistantVoice.showBriefing()}>
                        Read it
                      </button>
                    </>
                  )}
                  {mode === 'voice' && voiceState === 'listening' && (
                    <>
                      <button type="button" className={styles.primary} onClick={() => void assistantVoice.talk()}>
                        Done
                      </button>
                      <button type="button" className={styles.ghost} onClick={() => assistantVoice.cancelListening()}>
                        Cancel
                      </button>
                    </>
                  )}
                  {mode === 'voice' && voiceState === 'speaking' && (
                    <>
                      <button type="button" className={styles.ghost} onClick={() => assistantVoice.stopSpeaking()}>
                        <FiSquare aria-hidden /> Stop
                      </button>
                      <button type="button" className={styles.link} onClick={openConversation}>
                        Open conversation
                      </button>
                    </>
                  )}
                  {mode === 'answer' && (
                    <>
                      <button type="button" className={styles.primary} onClick={openConversation}>
                        {answer?.briefing ? 'Show briefing' : 'Open conversation'}
                      </button>
                      <button type="button" className={styles.ghost} onClick={() => void tap()}>
                        <FiMic aria-hidden /> Ask more
                      </button>
                    </>
                  )}
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          <button
            ref={fab}
            type="button"
            className={styles.fab}
            data-state={orb}
            onClick={() => void tap()}
            disabled={busy}
            aria-label={FAB_LABEL[voiceState]}
            aria-pressed={voiceState === 'listening'}
            title={FAB_LABEL[voiceState]}
          >
            <span className={styles.fabRing} aria-hidden />
            <span className={styles.fabRipple} aria-hidden />
            <span className={styles.fabCore}>
              {voiceState === 'speaking' ? (
                <span className={styles.eq} aria-hidden>
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <FiMic aria-hidden />
              )}
            </span>
            {nudge && briefing && mode !== 'voice' && <span className={styles.badge} aria-hidden />}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
