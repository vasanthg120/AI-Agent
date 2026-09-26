import { Droppable } from '@hello-pangea/dnd';
import clsx from 'clsx';
import { FiCheckCircle, FiCircle, FiLoader } from 'react-icons/fi';
import type { TodoTask, TaskStatus } from '@/services/todoEodService';
import { TaskCard } from './TaskCard';
import styles from './Column.module.css';

const STATUS_META: Record<TaskStatus, { icon: typeof FiCircle; empty: string }> = {
  todo: { icon: FiCircle, empty: 'Nothing waiting — drag a task here to put it back on the list.' },
  in_progress: { icon: FiLoader, empty: 'Drag a task here when you start on it.' },
  done: { icon: FiCheckCircle, empty: 'Finished tasks land here.' },
};

export function Column({ status, label, tasks }: { status: TaskStatus; label: string; tasks: TodoTask[] }) {
  const { icon: Icon, empty } = STATUS_META[status];
  return (
    <div className={clsx(styles.column, styles[status])}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Icon className={styles.statusIcon} />
          {label}
        </span>
        <span className={styles.count}>{tasks.length}</span>
      </div>
      <Droppable droppableId={status}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={clsx(styles.dropArea, snapshot.isDraggingOver && styles.dropAreaOver)}
          >
            {tasks.length === 0 && !snapshot.isDraggingOver && <div className={styles.empty}>{empty}</div>}
            {tasks.map((task, i) => (
              <TaskCard key={task.id} task={task} index={i} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
