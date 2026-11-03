import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiCloud, FiFileText, FiPaperclip, FiImage, FiMic, FiSend, FiSquare, FiX } from 'react-icons/fi';
import { CloudFilePickerModal } from '@/components/cloud-files';
import { IconButton, Tooltip } from '@/components/ui';
import { useAutosizeTextarea } from '@/hooks/useAutosizeTextarea';
import { useChatStore } from '@/stores/chatStore';
import { chatService, DEFAULT_ATTACHMENT_LIMITS } from '@/services/chatService';
import { mockSlashCommands } from '@/services/mock/fixtures/chat';
import type { ChatAgent, MessageAttachment } from '@/types';
import { extractErrorMessage } from '@/utils/errors';
import { formatBytes } from '@/utils/format';
import { generateId } from '@/utils/id';
import { VoiceInputModal } from './VoiceInputModal';
import styles from './ChatInput.module.css';

type Popup = { type: 'slash'; query: string } | { type: 'mention'; query: string } | null;

// A document picked for the next message: uploading, ready to send, or refused.
interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  error?: string;
  attachment?: MessageAttachment;
  abort?: AbortController;
}

const ATTACHMENT_ONLY_PROMPT = 'Please review the attached file(s).';
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const isImageName = (name: string) => IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [limits, setLimits] = useState(DEFAULT_ATTACHMENT_LIMITS);

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
    // The server's own limits; the defaults stand in until (or unless) they load.
    chatService.getAttachmentLimits().then(setLimits).catch(() => undefined);
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

  const isUploading = attachments.some((a) => a.status === 'uploading');

  const handleSubmit = () => {
    if (isStreamingCurrent) return;
    if (isUploading) {
      toast('Your document is still uploading — it will be ready in a moment.');
      return;
    }
    const ready = attachments.flatMap((a) => (a.status === 'ready' && a.attachment ? [a.attachment] : []));
    const trimmed = text.trim() || (ready.length > 0 ? ATTACHMENT_ONLY_PROMPT : '');
    if (!trimmed) return;
    void sendMessage(trimmed, selectedAgentId ?? undefined, ready);
    setText('');
    setPopup(null);
    setAttachments([]);
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

  const patchAttachment = (localId: string, patch: Partial<PendingAttachment>) =>
    setAttachments((list) => list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));

  // Each picked file is checked here (type, size, count) so an obvious
  // problem is reported at once, then uploaded: the server checks it again,
  // reads its text and returns the id that is sent with the message.
  const addFiles = (files: FileList | File[]) => {
    const picked = Array.from(files);
    if (picked.length === 0) return;
    const supported = 'PDF, Word (.docx), Excel, PowerPoint (.pptx), CSV, text, or an image (PNG, JPG, WebP)';
    let room = limits.maxPerMessage - attachments.filter((a) => a.status !== 'error').length;
    const accepted: { entry: PendingAttachment; file: File }[] = [];
    for (const file of picked) {
      const extension = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
      if (extension === '.doc') {
        toast.error(`“${file.name}” is an old Word file — save it as .docx or PDF and attach that.`);
      } else if (!limits.extensions.includes(extension)) {
        toast.error(`“${file.name}” can’t be attached. Supported: ${supported}.`);
      } else if (file.size === 0) {
        toast.error(`“${file.name}” is empty.`);
      } else if (file.size > limits.maxFileBytes) {
        toast.error(`“${file.name}” is ${formatBytes(file.size)} — files can be up to ${formatBytes(limits.maxFileBytes)}.`);
      } else if (attachments.some((a) => a.name === file.name && a.size === file.size && a.status !== 'error')) {
        toast(`“${file.name}” is already attached.`);
      } else if (room <= 0) {
        toast.error(`You can attach up to ${limits.maxPerMessage} files per message.`);
        break;
      } else {
        room -= 1;
        accepted.push({
          file,
          entry: {
            localId: generateId('att'),
            name: file.name,
            size: file.size,
            status: 'uploading',
            progress: 0,
            abort: new AbortController(),
          },
        });
      }
    }
    if (accepted.length === 0) return;
    setAttachments((list) => [...list, ...accepted.map((a) => a.entry)]);
    for (const { entry, file } of accepted) {
      chatService
        .uploadAttachment(file, (progress) => patchAttachment(entry.localId, { progress }), entry.abort?.signal)
        .then((attachment) => patchAttachment(entry.localId, { status: 'ready', progress: 100, attachment }))
        .catch((err) => {
          if (entry.abort?.signal.aborted) return; // removed while uploading
          patchAttachment(entry.localId, { status: 'error', error: extractErrorMessage(err) });
        });
    }
  };

  const removeAttachment = (target: PendingAttachment) => {
    target.abort?.abort();
    setAttachments((list) => list.filter((a) => a.localId !== target.localId));
    // Best-effort: an unsent upload expires on the server by itself anyway.
    if (target.attachment) void chatService.deleteAttachment(target.attachment.id).catch(() => undefined);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length === 0) return;
    event.preventDefault();
    addFiles(event.clipboardData.files);
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

      {attachments.length > 0 && (
        <div className={styles.attachmentsRow} aria-label="Attached documents">
          {attachments.map((a) => (
            <div
              key={a.localId}
              className={clsx(styles.attachmentChip, a.status === 'error' && styles.attachmentChipError)}
              title={a.status === 'error' ? a.error : a.name}
            >
              {a.status === 'error' ? <FiAlertCircle aria-hidden /> : isImageName(a.name) ? <FiImage aria-hidden /> : <FiFileText aria-hidden />}
              <span className={styles.attachmentText}>
                <span className={styles.attachmentName}>{a.name}</span>
                <span className={styles.attachmentMeta} role={a.status === 'error' ? 'alert' : undefined}>
                  {a.status === 'uploading'
                    ? a.progress < 100
                      ? `Uploading ${a.progress}%`
                      : isImageName(a.name)
                        ? 'Reading image…'
                        : 'Reading document…'
                    : a.status === 'error'
                      ? a.error
                      : formatBytes(a.size)}
                </span>
              </span>
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(a)}
                aria-label={`Remove ${a.name}`}
              >
                <FiX />
              </button>
              {a.status === 'uploading' && (
                <span className={styles.attachmentProgress} style={{ width: `${Math.max(a.progress, 4)}%` }} aria-hidden />
              )}
            </div>
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
          onPaste={handlePaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>

      <div className={styles.toolbarRow}>
        <div className={styles.toolbarLeft}>
          <Tooltip content="Attach files">
            <IconButton icon={<FiPaperclip />} label="Attach files" size="sm" onClick={() => fileInputRef.current?.click()} />
          </Tooltip>
          <Tooltip content="Attach from Google Drive or OneDrive">
            <IconButton icon={<FiCloud />} label="Attach from Google Drive or OneDrive" size="sm" onClick={() => setCloudOpen(true)} />
          </Tooltip>
          <Tooltip content="Attach images">
            <IconButton icon={<FiImage />} label="Attach images" size="sm" onClick={() => imageInputRef.current?.click()} />
          </Tooltip>
          <Tooltip content="Voice input">
            <IconButton icon={<FiMic />} label="Voice input" size="sm" onClick={() => setVoiceModalOpen(true)} />
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={limits.extensions.join(',')}
            className={styles.hiddenInput}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              // So the same file can be picked again after removing it.
              e.target.value = '';
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            multiple
            accept={limits.extensions.filter((ext) => IMAGE_EXTENSIONS.includes(ext)).join(',')}
            className={styles.hiddenInput}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
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
      {/* A copy of each picked file is attached, exactly like one chosen on this computer. */}
      <CloudFilePickerModal
        open={cloudOpen}
        onClose={() => setCloudOpen(false)}
        mode="pick"
        accept={limits.extensions.join(',')}
        maxBytes={limits.maxFileBytes}
        title="Attach from Google Drive or OneDrive"
        description="A copy of each file is attached to this message. The original stays where it is."
        onPick={(files) => addFiles(files)}
      />
    </div>
  );
}
