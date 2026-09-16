import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import clsx from 'clsx';
import { FiCopy, FiRefreshCw, FiEdit2, FiThumbsUp, FiThumbsDown, FiPlayCircle, FiCheck } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Avatar, IconButton, Badge, Button } from '@/components/ui';
import { formatMessageTime } from '@/utils/date';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import type { ChatMessage } from '@/types';
import { toolLabel } from '../toolLabels';
import { CodeBlock } from './CodeBlock';
import styles from './MessageBubble.module.css';

export interface MessageBubbleProps {
  message: ChatMessage;
  isLast: boolean;
}

export function MessageBubble({ message, isLast }: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const user = useAuthStore((state) => state.user);
  const setMessageFeedback = useChatStore((state) => state.setMessageFeedback);
  const regenerate = useChatStore((state) => state.regenerate);
  const sendMessage = useChatStore((state) => state.sendMessage);

  const isUser = message.role === 'user';
  const showCursor = message.status === 'streaming' && isLast;
  const isThinking = message.status === 'streaming' && !message.content;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  };

  const handleEditSubmit = () => {
    setIsEditing(false);
    if (draft.trim() && draft !== message.content) {
      void sendMessage(draft.trim());
    }
  };

  return (
    <div className={clsx(styles.row, isUser && styles.rowUser)}>
      <Avatar
        className={styles.avatar}
        name={isUser ? `${user?.firstName ?? 'You'} ${user?.lastName ?? ''}` : 'HaiVE AI'}
        color={isUser ? undefined : 'var(--brand-accent-secondary)'}
        size="sm"
      />
      <div className={styles.column}>
        <div className={styles.meta}>
          <span>{isUser ? 'You' : 'HaiVE AI'}</span>
          <span>&middot;</span>
          <span>{formatMessageTime(message.createdAt)}</span>
          {message.model && <Badge variant="neutral">{message.model}</Badge>}
        </div>

        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
            <textarea
              className={styles.editTextarea}
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className={styles.editActions}>
              <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleEditSubmit}>
                Save &amp; Submit
              </Button>
            </div>
          </div>
        ) : isThinking ? (
          <div className={clsx(styles.bubble, styles.bubbleAssistant, styles.bubbleThinking)}>
            <span className={styles.thinkingDots}>
              <span className={styles.thinkingDot} />
              <span className={styles.thinkingDot} />
              <span className={styles.thinkingDot} />
            </span>
            <span className={styles.thinkingLabel}>{message.statusText ?? toolLabel(message.progressTool)}</span>
          </div>
        ) : (
          <div className={clsx(styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant)}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                code({ className, children }) {
                  const match = /language-(\w+)/.exec(className ?? '');
                  if (!match) {
                    return <code className={className}>{children}</code>;
                  }
                  return (
                    <CodeBlock language={match[1]} codeClassName={className}>
                      {children}
                    </CodeBlock>
                  );
                },
                pre({ children }) {
                  return <>{children}</>;
                },
              }}
            >
              {message.content || ' '}
            </ReactMarkdown>
            {showCursor && <span className={styles.cursor} aria-hidden />}
          </div>
        )}

        {!!message.toolsUsed?.length && (
          <div className={styles.toolsRow}>
            {message.toolsUsed.map((tool) => (
              <Badge key={tool} variant="info">
                {tool}
              </Badge>
            ))}
          </div>
        )}

        {!isEditing && message.status !== 'streaming' && (
          <div className={styles.actionsRow}>
            <IconButton size="sm" icon={copied ? <FiCheck /> : <FiCopy />} label="Copy" onClick={handleCopy} />
            {isUser && <IconButton size="sm" icon={<FiEdit2 />} label="Edit prompt" onClick={() => setIsEditing(true)} />}
            {!isUser && isLast && (
              <IconButton size="sm" icon={<FiRefreshCw />} label="Regenerate" onClick={() => void regenerate()} />
            )}
            {!isUser && message.status === 'stopped' && isLast && (
              <IconButton
                size="sm"
                icon={<FiPlayCircle />}
                label="Continue generating"
                onClick={() => void sendMessage('Please continue from where you left off.')}
              />
            )}
            {!isUser && (
              <>
                <IconButton
                  size="sm"
                  icon={<FiThumbsUp />}
                  label="Good response"
                  className={message.feedback === 'up' ? styles.feedbackActive : undefined}
                  onClick={() => setMessageFeedback(message.id, 'up')}
                />
                <IconButton
                  size="sm"
                  icon={<FiThumbsDown />}
                  label="Bad response"
                  className={message.feedback === 'down' ? styles.feedbackActive : undefined}
                  onClick={() => setMessageFeedback(message.id, 'down')}
                />
              </>
            )}
          </div>
        )}

        {!isUser && isLast && message.status !== 'streaming' && !!message.suggestions?.length && (
          <div className={styles.suggestionsRow}>
            {message.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={styles.suggestionChip}
                onClick={() => void sendMessage(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
