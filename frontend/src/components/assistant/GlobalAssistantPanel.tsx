import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiX, FiExternalLink, FiEdit, FiMaximize2, FiMinimize2, FiSun } from 'react-icons/fi';
import { IconButton } from '@/components/ui';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useAssistantStore } from '@/stores/assistantStore';
import { ROUTES } from '@/constants/routes';
import { MessageList } from '@/features/chat/components/MessageList';
import { ChatInput } from '@/features/chat/components/ChatInput';
import type { ChatMessage } from '@/types';
import { extractErrorMessage } from '@/utils/errors';
import { assistantVoice } from './AssistantVoice';
import { HaiveStage } from './HaiveStage';
import { BriefingCard, DEFAULT_QUESTIONS, STATUS_TEXT, SuggestedQuestions, VoiceControls } from './AssistantBriefing';
import styles from './GlobalAssistantPanel.module.css';

// Stable reference — same reasoning as ChatPage.tsx's identical constant:
// a fresh [] on every zustand selector call defeats useSyncExternalStore's
// identity check and causes an infinite render loop.
const EMPTY_MESSAGES: ChatMessage[] = [];

// Haive, the voice-first assistant on every page — a shell around the SAME chat
// plumbing the full /chat page uses (useChatStore, MessageList, ChatInput): no
// second conversation state, socket or streaming path, so "Open full chat"
// lands on the same conversation, mid-stream if one is running. On top of it:
// today's spoken briefing (written from the business's own figures), suggested
// questions, and voice — tap to talk, answers spoken as they arrive, interrupt,
// mute (AssistantVoice).
export function GlobalAssistantPanel({ expanded, onToggleExpand }: { expanded: boolean; onToggleExpand: () => void }) {
  const navigate = useNavigate();
  const setAssistantPanelOpen = useUiStore((state) => state.setAssistantPanelOpen);
  const user = useAuthStore((state) => state.user);
  const briefing = useAssistantStore((state) => state.briefing);
  const settings = useAssistantStore((state) => state.settings);
  const voiceState = useAssistantStore((state) => state.voiceState);
  const queryClient = useQueryClient();
  const [preparing, setPreparing] = useState(false);

  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const messages = useChatStore((state) =>
    state.activeConversationId ? (state.messages[state.activeConversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const sendMessage = useChatStore((state) => state.sendMessage);
  const startNewConversation = useChatStore((state) => state.startNewConversation);

  const handleOpenFullChat = () => {
    setAssistantPanelOpen(false);
    navigate(activeConversationId ? ROUTES.chatConversation(activeConversationId) : ROUTES.chat);
  };

  const onBriefing = !!briefing && activeConversationId === briefing.conversationId;
  // The briefing conversation opens with the request and the spoken briefing: those show as the card above.
  const shown = onBriefing && messages[1]?.role === 'assistant' ? messages.slice(2) : messages;
  // The briefing's picks for today; else the person's own (AI Conversations settings); else Haive's.
  const ownQuestions = settings ? settings.questions.filter((q) => q.enabled).map((q) => q.text) : DEFAULT_QUESTIONS;
  const questions = briefing?.briefing.suggestedQuestions.length ? briefing.briefing.suggestedQuestions : ownQuestions.slice(0, 4);
  const voiceEnabled = settings?.voiceEnabled !== false;
  const ask = (question: string) => {
    assistantVoice.armReply(activeConversationId);
    void sendMessage(question);
  };
  const briefMe = async () => {
    setPreparing(true);
    try {
      await assistantVoice.briefMe(queryClient);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <span className={clsx(styles.headerLogo, styles[`logo_${voiceState}`])}>
            <img src="/haive-logo.png" alt="" className={styles.headerIcon} />
          </span>
          <span className={styles.headerText}>
            Haive
            <span className={styles.headerStatus} aria-live="polite">
              <span className={clsx(styles.statusDot, styles[`dot_${voiceState}`])} /> {STATUS_TEXT[voiceState]}
            </span>
          </span>
        </span>
        <div className={styles.headerActions}>
          {activeConversationId && <IconButton icon={<FiEdit />} label="New chat" size="sm" onClick={startNewConversation} />}
          <IconButton icon={expanded ? <FiMinimize2 /> : <FiMaximize2 />} label={expanded ? 'Make smaller' : 'Make bigger'} size="sm" onClick={onToggleExpand} />
          <IconButton icon={<FiExternalLink />} label="Open full chat" size="sm" onClick={handleOpenFullChat} />
          <IconButton icon={<FiX />} label="Close assistant" size="sm" onClick={() => setAssistantPanelOpen(false)} />
        </div>
      </div>

      {/* Haive on stage while it listens, thinks or speaks: avatar, voice waveform, what it is saying. */}
      <HaiveStage />

      <div className={clsx(styles.body, onBriefing && styles.bodyStack)}>
        {activeConversationId ? (
          onBriefing ? (
            <>
              {/* Until the conversation starts, the briefing (and its questions) has the whole window. */}
              <div className={clsx(styles.cardSlot, shown.length === 0 && !isLoadingMessages && styles.cardSlotFull)}>
                <BriefingCard briefing={briefing!} />
                {shown.length === 0 && <SuggestedQuestions questions={questions} onAsk={ask} />}
              </div>
              {(shown.length > 0 || isLoadingMessages) && (
                <div className={styles.listSlot}>
                  <MessageList messages={shown} isLoading={isLoadingMessages} />
                </div>
              )}
            </>
          ) : (
            <MessageList messages={messages} isLoading={isLoadingMessages} />
          )
        ) : (
          <div className={styles.welcome}>
            <div>
              <div className={styles.welcomeTitle}>Hi {user?.firstName ?? 'there'}</div>
              <p className={styles.welcomeSubtitle}>
                {voiceEnabled ? 'Ask me anything about your business — tap the mic and speak, or type.' : 'Ask me anything about your business.'}
              </p>
            </div>
            {briefing ? (
              <BriefingCard briefing={briefing} compact />
            ) : (
              settings &&
              !settings.briefingEnabled && (
                <button type="button" className={styles.briefMe} onClick={() => void briefMe()} disabled={preparing}>
                  <FiSun aria-hidden /> {preparing ? 'Preparing your briefing…' : 'Brief me on my business'}
                </button>
              )
            )}
            <SuggestedQuestions questions={questions} onAsk={ask} />
          </div>
        )}
      </div>

      <div className={styles.footer}>
        {voiceEnabled && <VoiceControls />}
        <ChatInput />
      </div>
    </div>
  );
}
