import { Draggable } from '@hello-pangea/dnd';
import clsx from 'clsx';
import { FiCheck, FiMoreVertical } from 'react-icons/fi';
import { Badge } from '@/components/ui';
import type { TodoTask, TaskPriority } from '@/services/todoEodService';
import styles from './TaskCard.module.css';

export const PRIORITY_VARIANT: Record<TaskPriority, 'danger' | 'warning' | 'accent' | 'neutral'> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'accent',
  low: 'neutral',
};

export function TaskCard({ task, index }: { task: TodoTask; index: number }) {
  const done = task.status === 'done';
  return (
    <Draggable draggableId={task.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={clsx(styles.card, styles[task.priority], snapshot.isDragging && styles.dragging, done && styles.done)}
        >
          {/* Inner wrapper carries the hover/drag transforms — the outer
              element's transform belongs to the drag library. */}
          <div className={styles.inner}>
            <div className={styles.top}>
              {done && (
                <span className={styles.check}>
                  <FiCheck />
                </span>
              )}
              <span className={styles.title}>{task.title}</span>
              <FiMoreVertical className={styles.grip} aria-hidden />
            </div>
            <div className={styles.meta}>
              <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
              {task.isOverdue && !done && <Badge variant="danger">Overdue</Badge>}
              {task.category && <span className={styles.category}>{task.category}</span>}
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}
