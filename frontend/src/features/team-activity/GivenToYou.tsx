import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { FiUserCheck } from 'react-icons/fi';
import { SectionCard } from '@/components/ui';
import { teamActivityService, type TeamFollowUpItem } from '@/services/teamActivityService';
import { TaskButtons } from './TaskButtons';
import styles from './TeamTasks.module.css';

const ORIGIN: Record<NonNullable<TeamFollowUpItem['origin']>, string> = { team: '', customer: 'On a customer', job: 'On a job', deal: 'On a deal' };

function TaskLine({ task }: { task: TeamFollowUpItem }) {
  const done = task.status === 'done';
  const from = task.origin && task.origin !== 'team' ? ORIGIN[task.origin] : task.givenBy ? `From ${task.givenBy}` : '';
  return (
    <li className={clsx(styles.mineRow, done && styles.mineRowDone)}>
      <span className={styles.mineMain}>
        <span className={clsx(styles.mineTitle, done && styles.mineTitleDone)}>{task.title}</span>
        <span className={styles.mineMeta}>
          {!done && task.inProgress && <span className={clsx(styles.chip, styles.chip_progress)}>In progress</span>}
          {!done && task.overdue && <span className={clsx(styles.chip, styles.chip_danger)}>Overdue</span>}
          {!done && task.priority === 'high' && <span className={clsx(styles.chip, styles.chip_high)}>High priority</span>}
          {done && <span className={clsx(styles.chip, styles.chip_done)}>Done</span>}
          <span>
            {[from, done ? (task.completedAt ? `done ${dayjs(task.completedAt).format('D MMM')}` : '') : task.dueDate ? `due ${dayjs(task.dueDate).format('ddd D MMM')}` : 'no due date']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {task.note && <span className={styles.note}>{task.note}</span>}
      </span>
      <TaskButtons task={task} />
    </li>
  );
}

// The To-Do page's tasks people were given — by a manager in Agent Activity, on a
// customer, a job or a deal — next to the AI's daily list. Start, finish or reopen
// them here; managers see each move in Agent Activity straight away.
export function GivenToYou() {
  const [showDone, setShowDone] = useState(false);
  const { data } = useQuery({ queryKey: ['my-team-tasks'], queryFn: teamActivityService.myTasks, refetchInterval: 120_000 });
  if (!data || data.items.length === 0) return null;
  const open = data.items.filter((t) => t.status !== 'done');
  const done = data.items.filter((t) => t.status === 'done');
  const summary = [`${data.open} to do`, data.inProgress ? `${data.inProgress} in progress` : '', data.overdue ? `${data.overdue} overdue` : ''].filter(Boolean).join(' · ');
  return (
    <SectionCard title={`Given to you · ${summary}`} icon={FiUserCheck}>
      {open.length > 0 ? (
        <ul className={styles.mine}>
          {open.map((t) => (
            <TaskLine key={t.id} task={t} />
          ))}
        </ul>
      ) : (
        <p className={styles.note}>Nothing waiting — everything given to you is done.</p>
      )}
      {done.length > 0 && (
        <>
          <button type="button" className={styles.more} onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            {showDone ? 'Hide' : 'Show'} done this week ({done.length})
          </button>
          {showDone && (
            <ul className={styles.mine}>
              {done.map((t) => (
                <TaskLine key={t.id} task={t} />
              ))}
            </ul>
          )}
        </>
      )}
    </SectionCard>
  );
}
