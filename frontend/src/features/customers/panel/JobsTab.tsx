import { useQuery } from '@tanstack/react-query';
import { FiAlertCircle } from 'react-icons/fi';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { customerJobsService } from '@/services/customerJobsService';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate, formatMoney } from '../format';
import { StageChip } from '../StageChip';
import detailStyles from '../customer-detail.module.css';
import styles from './panel.module.css';

// Hoops-parity Customer Profile "Jobs" tab — every job made from one of this
// customer's quotations (the same real jobs the Job board itself lists,
// narrowed server-side by customerId — customer-jobs.service.ts's own
// list() filter). A click opens the job in full, same as everywhere else
// a job is named.
export function JobsTab({ customerId, onOpenJob }: { customerId: string; onOpenJob?: (jobId: string, number?: string) => void }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['customer-jobs', 'of-customer', customerId],
    queryFn: () => customerJobsService.list({ customerId, pageSize: 100 }),
  });

  if (isLoading) return <Skeleton height={160} />;
  if (isError || !data)
    return (
      <EmptyState
        compact
        icon={FiAlertCircle}
        title="Couldn’t load this customer’s jobs"
        description={extractErrorMessage(error)}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  if (data.items.length === 0) return <p className={detailStyles.muted}>No jobs yet — "Convert to job" on an accepted quotation makes one.</p>;

  return (
    <ul className={styles.notes}>
      {data.items.map((job) => (
        <li
          key={job.id}
          className={styles.docRow}
          tabIndex={0}
          role="button"
          onClick={() => onOpenJob?.(job.id, job.number)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenJob?.(job.id, job.number);
            }
          }}
        >
          <div className={styles.noteHead}>
            <strong>{job.number}</strong>
            <span>{job.title}</span>
            {job.dueDate && <time dateTime={job.dueDate}>Due {formatDate(job.dueDate)}</time>}
            <span>{formatMoney(job.amount, job.currency)}</span>
          </div>
          <div className={styles.chipWrap}>
            {job.statuses
              .filter((chip) => chip.status)
              .map((chip) => (
                <StageChip key={chip.key} stage={chip} />
              ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
