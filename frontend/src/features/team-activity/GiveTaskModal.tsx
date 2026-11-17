import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Button, Input, Modal } from '@/components/ui';
import { teamActivityService } from '@/services/teamActivityService';
import { extractErrorMessage } from '@/utils/errors';
import styles from './TeamTasks.module.css';

/** "YYYY-MM-DD" for a day from today, in the browser's own calendar. */
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const QUICK_DAYS = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'In a week', days: 7 },
];

/** Refreshes every view a task shows in: the figures, the lists, the person's own To-Do. */
export function invalidateTaskViews(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ['team-activity', 'team-activity-person', 'team-activity-list', 'my-team-tasks']) void queryClient.invalidateQueries({ queryKey: [key] });
}

// A manager gives someone a task straight from Agent Activity: what, by when, how
// urgent. It lands on the person's To-Do page (and their bell), and counts in
// their figures here as open, in progress, done or overdue.
export function GiveTaskModal({
  person,
  onClose,
}: {
  person: { userId: string; name: string; businessId: string } | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState(dayFromToday(1));
  const [high, setHigh] = useState(false);

  useEffect(() => {
    if (!person) return;
    setTitle('');
    setNote('');
    setDue(dayFromToday(1));
    setHigh(false);
  }, [person]);

  const give = useMutation({
    mutationFn: () =>
      teamActivityService.giveTask({
        organizationId: person!.businessId,
        assigneeId: person!.userId,
        title: title.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        // The end of the chosen day, in the browser's own time.
        ...(due ? { dueDate: new Date(`${due}T23:59:00`).toISOString() } : {}),
        priority: high ? 'high' : 'normal',
      }),
    onSuccess: () => {
      toast.success(`Task given to ${person!.name}`);
      invalidateTaskViews(queryClient);
      onClose();
    },
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || give.isPending) return;
    give.mutate();
  };

  return (
    <Modal open={!!person} onClose={onClose} title={person ? `Give ${person.name} a task` : ''} description="It appears on their To-Do page and in their figures here." maxWidth={520}>
      <form className={styles.form} onSubmit={submit}>
        <Input label="What needs doing" value={title} maxLength={200} autoFocus placeholder="e.g. Call back the three Diwali enquiries" onChange={(e) => setTitle(e.target.value)} />

        <div className={styles.field}>
          <span className={styles.fieldLabel}>By when</span>
          <div className={styles.dueRow}>
            {QUICK_DAYS.map((q) => (
              <button
                key={q.label}
                type="button"
                className={clsx(styles.choice, due === dayFromToday(q.days) && styles.choiceOn)}
                aria-pressed={due === dayFromToday(q.days)}
                onClick={() => setDue(dayFromToday(q.days))}
              >
                {q.label}
              </button>
            ))}
            <input type="date" className={styles.date} value={due} min={dayFromToday(0)} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
            <button type="button" className={clsx(styles.choice, !due && styles.choiceOn)} aria-pressed={!due} onClick={() => setDue('')}>
              No date
            </button>
          </div>
        </div>

        <label className={styles.check}>
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} />
          High priority
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Note (optional)</span>
          <textarea className={styles.textarea} rows={3} maxLength={1000} value={note} placeholder="Anything they should know" onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={give.isPending} disabled={!title.trim()}>
            Give task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
