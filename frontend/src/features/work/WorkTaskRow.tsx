import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Badge, Button, Modal } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { workAutomationService } from '@/services/workAutomationService';
import type { WorkAction, WorkTask } from '@/services/workAutomationService';
import { availableActions, dueLabel, evidenceLabel, platformLabel, PRIORITY_VARIANT, STATUS_LABEL, STATUS_VARIANT } from './workUtils';
import styles from './Work.module.css';

interface Props {
  task: WorkTask;
  /** Whether the person looking is the one the task is assigned to / may verify it. */
  isAssignee: boolean;
  canVerify: boolean;
  onChanged: () => void;
}

/** One task: what it is, where it came from, its state and (for completed work) what proves it. Status changes that need a note ask for one. */
export function WorkTaskRow({ task, isAssignee, canVerify, onChanged }: Props) {
  const [pending, setPending] = useState<{ action: WorkAction; label: string } | null>(null);
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: (args: { action: WorkAction; note?: string }) => workAutomationService.act(task.id, args.action, args.note),
    onSuccess: () => {
      setPending(null);
      setNote('');
      onChanged();
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const actions = availableActions(task, { isAssignee, canVerify });

  return (
    <div className={clsx(styles.row, task.effectiveStatus === 'overdue' && styles.rowOverdue)} data-testid="work-task-row">
      <div className={styles.rowMain}>
        <span className={styles.title}>{task.title}</span>
        <div className={styles.meta}>
          <Badge variant={STATUS_VARIANT[task.effectiveStatus]}>{STATUS_LABEL[task.effectiveStatus]}</Badge>
          <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
          <span>{platformLabel(task.sourcePlatform)}</span>
          {task.dueDate && <span>{dueLabel(task.dueDate)}</span>}
          {task.sourceUrl && (
            <a className={styles.link} href={task.sourceUrl} title="Open the source record in Haive">
              Open source
            </a>
          )}
        </div>
        {task.description && <span className={styles.evidence}>{task.description}</span>}
        {task.status === 'completed' && task.completionEvidence && (
          <span className={styles.evidence}>
            {evidenceLabel(task.completionEvidence.type)}: {task.completionEvidence.detail}
          </span>
        )}
      </div>
      {actions.length > 0 && (
        <div className={styles.actions}>
          {actions.map((a) => (
            <Button
              key={a.action}
              type="button"
              size="sm"
              variant={a.action === 'verify' ? 'primary' : 'outline'}
              loading={mutation.isPending && mutation.variables?.action === a.action}
              onClick={() => (a.needsNote ? setPending({ action: a.action, label: a.label }) : mutation.mutate({ action: a.action }))}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      <Modal open={!!pending} onClose={() => setPending(null)} title={pending?.label} description={task.title} maxWidth={460}>
        <textarea
          className={styles.noteInput}
          aria-label="Note"
          placeholder="Add a short note (required)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className={styles.modalActions}>
          <Button type="button" variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button type="button" disabled={!note.trim()} loading={mutation.isPending} onClick={() => pending && mutation.mutate({ action: pending.action, note: note.trim() })}>
            {pending?.label}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
