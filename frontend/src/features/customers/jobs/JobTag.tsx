import { FiLayers } from 'react-icons/fi';
import type { JobRef } from '@/services/customersService';
import styles from './jobs.module.css';

// The job something belongs to — a customer's row, a quotation, a comment, a task, a file. Where the
// page can show the job, the tag opens it.
export function JobTag({ job, onOpen }: { job: JobRef; onOpen?: (jobId: string, number?: string) => void }) {
  const label = (
    <>
      <FiLayers aria-hidden /> Job {job.number}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className={styles.jobTag}
      title={`Open job ${job.number}`}
      // Inside a row that opens something else: the tag acts on its own.
      onClick={(event) => {
        event.stopPropagation();
        onOpen(job.id, job.number);
      }}
    >
      {label}
    </button>
  ) : (
    <span className={styles.jobTag}>{label}</span>
  );
}
