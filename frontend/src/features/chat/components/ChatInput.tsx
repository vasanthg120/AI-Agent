import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { FiPaperclip, FiImage, FiMic, FiSend, FiSquare } from 'react-icons/fi';
import { IconButton, Tooltip } from '@/components/ui';
import { useAutosizeTextarea } from '@/hooks/useAutosizeTextarea';
import { useChatStore } from '@/stores/chatStore';
import { chatService } from '@/services/chatService';
import { mockSlashCommands } from '@/services/mock/fixtures/chat';
import type { ChatAgent } from '@/types';
import { VoiceInputModal } from './VoiceInputModal';
import styles from './ChatInput.module.css';

type Popup = { type: 'slash'; query: string } | { type: 'mention'; query: string } | null;

export interface ChatInputProps {
  prefillText?: string;
  onPrefillConsumed?: () => void;
}

export function ChatInput({ prefillText, onPrefillConsumed }: ChatInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [popup, setPopup] = useState<Popup>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useAutosizeTextarea(textareaRef, text);

  useEffect(() => {
    if (!prefillText) return;
    setText(prefillText);
    textareaRef.current?.focus();
    onPrefillConsumed?.();
    // onPrefillConsumed intentionally excluded — including it would refire this effect
    // whenever the parent re-renders with a new inline callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);

  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const streamingConversationId = useChatStore((state) => state.streamingConversationId);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopGeneration = useChatStore((state) => state.stopGeneration);

  const isStreamingCurrent = streamingConversationId !== null && streamingConversationId === activeConversationId;

  useEffect(() => {
    chatService.getAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  // A freshly-typed @mention only applies to the next message being
  // composed — once sent, the conversation's persona becomes sticky
  // server-side (see chatStore's activeAgentId), so there's nothing left
  // for this local selection to do until the user starts a new/different
  // conversation.
  useEffect(() => {
    setSelectedAgentId(null);
  }, [activeConversationId]);

  const slashMatches = useMemo(() => {
    if (popup?.type !== 'slash') return [];
    return mockSlashCommands.filter((c) => c.command.slice(1).toLowerCase().startsWith(popup.query.toLowerCase()));
  }, [popup]);

  const mentionMatches = useMemo(() => {
    if (popup?.type !== 'mention') return [];
    return agents.filter((a) => a.name.toLowerCase().includes(popup.query.toLowerCase()));
  }, [popup, agents]);

  const popupItemCount = popup?.type === 'slash' ? slashMatches.length : popup?.type === 'mention' ? mentionMatches.length : 0;

  const detectTrigger = (value: string, cursor: number) => {
    const upToCursor = value.slice(0, cursor);
    const match = /(?:^|\s)([/@])(\w*)$/.exec(upToCursor);
    if (!match) {
      setPopup(null);
      return;
    }
    setActiveIndex(0);
    setPopup(match[1] === '/' ? { type: 'slash', query: match[2] } : { type: 'mention', query: match[2] });
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    detectTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const insertToken = (token: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? text.length;
    const upToCursor = text.slice(0, cursor);
    const replaced = upToCursor.replace(/(?:^|\s)([/@])(\w*)$/, (whole, trigger: string) => {
      const prefix = whole.startsWith(trigger) ? '' : whole[0];
      return `${prefix}${token} `;
    });
    const newText = replaced + text.slice(cursor);
    setText(newText);
    setPopup(null);
    requestAnimationFrame(() => el.focus());
  };

  const selectAgentMention = (agent: ChatAgent) => {
    insertToken(`@${agent.name.replace(/\s+/g, '')}`);
    setSelectedAgentId(agent.id);
  };

  const handleSubmit = () => {
    if (isStreamingCurrent) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    void sendMessage(trimmed, selectedAgentId ?? undefined);
    setText('');
    setPopup(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && popupItemCount > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % popupItemCount);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + popupItemCount) % popupItemCount);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const safeIndex = Math.min(activeIndex, popupItemCount - 1);
        if (popup.type === 'slash') insertToken(slashMatches[safeIndex].command);
        else selectAgentMention(mentionMatches[safeIndex]);
        return;
      }
      if (event.key === 'Escape') {
        setPopup(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  // handleSubmit only ever sends `text` — there is no attachments field
  // anywhere on SendMessageDto/the chat send path, so a file picked here
  // used to render a normal-looking "attached" chip and then silently never
  // reach the backend at all, with nothing telling the user their file
  // wasn't actually sent. Until real upload support exists, surface that
  // plainly instead of pretending it worked.
  const addFiles = (files: FileList | File[]) => {
    if (files.length === 0) return;
    toast.error("File attachments aren't supported yet — only your typed message will be sent.");
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };

  const tokenEstimate = Math.ceil(text.length / 4);

  return (
    <div
      className={clsx(styles.container, focused && styles.containerFocused, dragOver && styles.dragOver)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {popup && popupItemCount > 0 && (
        <div className={styles.popup} role="listbox">
          {popup.type === 'slash' &&
            slashMatches.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                className={clsx(styles.popupItem, index === activeIndex && styles.popupItemActive)}
                onClick={() => insertToken(cmd.command)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.popupItemIcon}>/</span>
                <span>
                  <div className={styles.popupItemLabel}>{cmd.label}</div>
                  <div className={styles.popupItemDescription}>{cmd.description}</div>
                </span>
              </button>
            ))}
          {popup.type === 'mention' &&
            mentionMatches.map((agent, index) => (
              <button
                key={agent.id}
                type="button"
                className={clsx(styles.popupItem, index === activeIndex && styles.popupItemActive)}
                onClick={() => selectAgentMention(agent)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={styles.popupItemIcon} style={{ background: agent.avatarColor, color: '#fff' }}>
                  {agent.name[0]}
                </span>
                <span>
                  <div className={styles.popupItemLabel}>{agent.name}</div>
                  <div className={styles.popupItemDescription}>{agent.description}</div>
                </span>
              </button>
            ))}
        </div>
      )}

      <div className={styles.textareaRow}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="Message HaiVE AI... use / for commands or @ to mention an agent"
          rows={1}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>

      <div className={styles.toolbarRow}>
        <div className={styles.toolbarLeft}>
          <Tooltip content="Attach files">
            <IconButton icon={<FiPaperclip />} label="Attach files" size="sm" onClick={() => fileInputRef.current?.click()} />
          </Tooltip>
          <Tooltip content="Attach images">
            <IconButton icon={<FiImage />} label="Attach images" size="sm" onClick={() => imageInputRef.current?.click()} />
          </Tooltip>
          <Tooltip content="Voice input">
            <IconButton icon={<FiMic />} label="Voice input" size="sm" onClick={() => setVoiceModalOpen(true)} />
          </Tooltip>
          <input ref={fileInputRef} type="file" multiple className={styles.hiddenInput} onChange={(e) => e.target.files && addFiles(e.target.files)} />
          <input
            ref={imageInputRef}
            type="file"
            multiple
            accept="image/*"
            className={styles.hiddenInput}
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </div>
        <div className={styles.toolbarRight}>
          <span className={styles.tokenCounter}>~{tokenEstimate} tokens</span>
          {isStreamingCurrent ? (
            <IconButton icon={<FiSquare />} label="Stop generating" onClick={stopGeneration} style={{ background: 'var(--color-danger)', color: '#fff' }} />
          ) : (
            <IconButton
              icon={<FiSend />}
              label="Send message"
              onClick={handleSubmit}
              style={{ background: 'var(--gradient-accent)', color: '#fff' }}
            />
          )}
        </div>
      </div>
      <VoiceInputModal open={voiceModalOpen} onClose={() => setVoiceModalOpen(false)} />
    </div>
  );
}
