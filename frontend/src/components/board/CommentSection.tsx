import { useState } from 'react';
import type { ReactNode } from 'react';
import { FiMessageSquare, FiSend } from 'react-icons/fi';
import { Button, EmptyState } from '@/components/ui';
import { formatRelativeTime } from '@/utils/date';
import styles from './CommentSection.module.css';

export interface Comment {
  id: string;
  body: string;
  by: string;
  at: string;
}

export interface CommentSectionProps {
  // Omit when this record has no comment thread wired up yet.
  comments?: Comment[];
  posting?: boolean;
  onPost?: (body: string) => void;
  notConnectedMessage?: string;
  notConnectedAction?: ReactNode;
}

export function CommentSection({ comments, posting, onPost, notConnectedMessage, notConnectedAction }: CommentSectionProps) {
  const [draft, setDraft] = useState('');

  if (!comments || !onPost) {
    return (
      <EmptyState
        icon={FiMessageSquare}
        title="Comments aren't connected here yet"
        description={notConnectedMessage ?? "This record doesn't have its own comment thread in HaiVE yet."}
        action={notConnectedAction}
      />
    );
  }

  const send = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onPost(trimmed);
    setDraft('');
  };

  return (
    <div className={styles.wrap}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className={styles.textarea}
          placeholder="Write a comment…"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" size="sm" leftIcon={<FiSend />} loading={posting} disabled={!draft.trim()}>
          Post
        </Button>
      </form>
      {comments.length === 0 ? (
        <p className={styles.muted}>No comments yet.</p>
      ) : (
        <ul className={styles.list}>
          {comments.map((c) => (
            <li key={c.id} className={styles.item}>
              <div className={styles.head}>
                <strong>{c.by}</strong>
                <time dateTime={c.at}>{formatRelativeTime(c.at)}</time>
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
