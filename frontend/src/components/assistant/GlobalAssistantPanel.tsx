import { useNavigate } from 'react-router-dom';
import { FiX, FiMaximize2, FiFileText, FiMail, FiBarChart2, FiUsers } from 'react-icons/fi';
import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { mockPromptSuggestions } from '@/services/mock/fixtures/chat';
import { ROUTES } from '@/constants/routes';
import { MessageList } from '@/features/chat/components/MessageList';
import { ChatInput } from '@/features/chat/components/ChatInput';
import type { ChatMessage } from '@/types';
import styles from './GlobalAssistantPanel.module.css';

// Stable reference — same reasoning as ChatPage.tsx's identical constant:
// a fresh [] on every zustand selector call defeats useSyncExternalStore's
// identity check and causes an infinite render loop.
const EMPTY_MESSAGES: ChatMessage[] = [];

const SUGGESTION_ICONS: Record<string, ReactElement> = {
  'file-text': <FiFileText />,
  mail: <FiMail />,
  'bar-chart': <FiBarChart2 />,
  users: <FiUsers />,
};

// The Outlook-Copilot-style global AI Assistant — a thin presentational
// shell around the SAME chat plumbing the full /chat page uses
// (useChatStore, MessageList, ChatInput). It creates no new conversation
// state, no new socket, no new streaming path: opening this panel, sending
// a message, then clicking "Open full chat" lands on the exact same
// activeConversationId/messages already in the store, mid-stream if one is
// running. This component only ever composes existing pieces.
export function GlobalAssistantPanel() {
  const navigate = useNavigate();
  const setAssistantPanelOpen = useUiStore((state) => state.setAssistantPanelOpen);
  const user = useAuthStore((state) => state.user);

  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const messages = useChatStore((state) =>
    state.activeConversationId ? (state.messages[state.activeConversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const sendMessage = useChatStore((state) => state.sendMessage);

  const handleOpenFullChat = () => {
    setAssistantPanelOpen(false);
    navigate(activeConversationId ? ROUTES.chatConversation(activeConversationId) : ROUTES.chat);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <img src="/haive-logo.png" alt="" className={styles.headerIcon} /> Haive AI
        </span>
        <div className={styles.headerActions}>
          <IconButton icon={<FiMaximize2 />} label="Open full chat" size="sm" onClick={handleOpenFullChat} />
          <IconButton icon={<FiX />} label="Close assistant" size="sm" onClick={() => setAssistantPanelOpen(false)} />
        </div>
      </div>

      <div className={styles.body}>
        {activeConversationId ? (
          <MessageList messages={messages} isLoading={isLoadingMessages} />
        ) : (
          <div className={styles.welcome}>
            <div>
              <div className={styles.welcomeTitle}>Hi {user?.firstName ?? 'there'}</div>
              <p className={styles.welcomeSubtitle}>Ask a question about your workspace, or pick a suggestion to get started.</p>
            </div>
            <div className={styles.suggestionList}>
              {mockPromptSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={styles.suggestionRow}
                  onClick={() => void sendMessage(suggestion.prompt)}
                >
                  <span className={styles.suggestionIcon}>{SUGGESTION_ICONS[suggestion.icon] ?? <FiFileText />}</span>
                  <span className={styles.suggestionText}>
                    <span className={styles.suggestionTitle}>{suggestion.title}</span>
                    <span className={styles.suggestionPrompt}>{suggestion.prompt}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <ChatInput />
      </div>
    </div>
  );
}
