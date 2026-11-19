import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { FiCheck, FiPlay, FiRotateCcw } from 'react-icons/fi';
import { teamActivityService, type TaskMove } from '@/services/teamActivityService';
import { extractErrorMessage } from '@/utils/errors';
import { invalidateTaskViews } from './GiveTaskModal';
import styles from './TeamTasks.module.css';

const SAID: Record<TaskMove, string> = { in_progress: 'Started', done: 'Marked done', todo: 'Back to to-do' };

/** Moves a task along — Start, Done, or Reopen — for the person it is given to or their manager. */
export function TaskButtons({ task }: { task: { id: string; title: string; status: 'pending' | 'done'; inProgress?: boolean } }) {
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: (status: TaskMove) => teamActivityService.moveTask(task.id, { status }),
    onSuccess: (_moved, status) => {
      toast.success(SAID[status]);
      invalidateTaskViews(queryClient);
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });
  const busy = move.isPending;

  if (task.status === 'done') {
    return (
      <span className={styles.taskButtons}>
        <button type="button" className={styles.taskButton} disabled={busy} onClick={() => move.mutate('todo')} aria-label={`Reopen “${task.title}”`}>
          <FiRotateCcw aria-hidden /> Reopen
        </button>
      </span>
    );
  }
  return (
    <span className={styles.taskButtons}>
      {!task.inProgress && (
        <button type="button" className={styles.taskButton} disabled={busy} onClick={() => move.mutate('in_progress')} aria-label={`Start “${task.title}”`}>
          <FiPlay aria-hidden /> Start
        </button>
      )}
      <button type="button" className={clsx(styles.taskButton, styles.taskButtonDone)} disabled={busy} onClick={() => move.mutate('done')} aria-label={`Mark “${task.title}” done`}>
        <FiCheck aria-hidden /> Done
      </button>
    </span>
  );
}
