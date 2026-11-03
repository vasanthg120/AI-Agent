import type { ReactNode } from 'react';
import dayjs from 'dayjs';
import { FiCheckSquare, FiSquare } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, EmptyState } from '@/components/ui';
import styles from './TaskList.module.css';

const formatDueDate = (iso: string) => dayjs(iso).format('MMM D');

export interface BoardTask {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  overdue?: boolean;
  assignee?: string;
}

export interface TaskListProps {
  // Omit when this record has no task list wired up yet.
  tasks?: BoardTask[];
  onToggle?: (task: BoardTask) => void;
  notConnectedMessage?: string;
  notConnectedAction?: ReactNode;
}

export function TaskList({ tasks, onToggle, notConnectedMessage, notConnectedAction }: TaskListProps) {
  if (!tasks) {
    return (
      <EmptyState
        icon={FiCheckSquare}
        title="Tasks aren't connected here yet"
        description={notConnectedMessage ?? "This record doesn't have its own task list in HaiVE yet."}
        action={notConnectedAction}
      />
    );
  }
  if (tasks.length === 0) return <p className={styles.muted}>No tasks yet.</p>;
  return (
    <ul className={styles.list}>
      {tasks.map((task) => (
        <li key={task.id} className={styles.item}>
          <button
            type="button"
            className={styles.toggle}
            aria-label={task.done ? `Mark ${task.title} as not done` : `Mark ${task.title} as done`}
            disabled={!onToggle}
            onClick={() => onToggle?.(task)}
          >
            {task.done ? <FiCheckSquare aria-hidden /> : <FiSquare aria-hidden />}
          </button>
          <span className={clsx(styles.title, task.done && styles.titleDone)}>{task.title}</span>
          {task.assignee && <span className={styles.assignee}>{task.assignee}</span>}
          {task.dueDate && (
            <Badge variant={task.overdue ? 'danger' : 'neutral'}>
              {task.overdue ? 'Overdue · ' : 'Due '}
              {formatDueDate(task.dueDate)}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
