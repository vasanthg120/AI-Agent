import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { FiAlertCircle, FiCheckCircle, FiCircle, FiLoader } from 'react-icons/fi';
import { todoEodService, type ListTasksParams } from '@/services/todoEodService';
import styles from './DayProgress.module.css';

// Same queryKey as Board's own ['tasks', params] — React Query dedupes it,
// so this is a second subscriber to the one cached fetch, never a new request.
export function DayProgress({ params }: { params: ListTasksParams }) {
  const { data } = useQuery({
    queryKey: ['tasks', params],
    queryFn: () => todoEodService.getTasks(params),
  });

  if (!data || data.length === 0) return null;

  const total = data.length;
  const done = data.filter((t) => t.status === 'done').length;
  const inProgress = data.filter((t) => t.status === 'in_progress').length;
  const todo = total - done - inProgress;
  const overdue = data.filter((t) => t.isOverdue && t.status !== 'done').length;
  const pct = Math.round((done / total) * 100);

  const message =
    pct === 100 ? 'Everything is done — great work.' : pct >= 50 ? 'Past the halfway mark.' : `${total - done} left to go.`;

  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <div className={styles.headline}>
          <span className={styles.big}>
            {done}
            <span className={styles.of}>/{total}</span>
          </span>
          <span className={styles.caption}>tasks done · {message}</span>
        </div>
        <span className={styles.pct}>{pct}%</span>
      </div>

      <div className={styles.track} aria-hidden>
        <motion.div
          className={styles.fill}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>

      <div className={styles.stats}>
        <span className={styles.stat}>
          <FiCircle className={styles.todo} /> {todo} to do
        </span>
        <span className={styles.stat}>
          <FiLoader className={styles.progress} /> {inProgress} in progress
        </span>
        <span className={styles.stat}>
          <FiCheckCircle className={styles.done} /> {done} done
        </span>
        {overdue > 0 && (
          <span className={`${styles.stat} ${styles.overdueStat}`}>
            <FiAlertCircle /> {overdue} overdue
          </span>
        )}
      </div>
    </div>
  );
}
