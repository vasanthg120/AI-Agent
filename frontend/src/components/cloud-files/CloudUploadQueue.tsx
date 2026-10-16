import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FiCheck, FiRotateCw, FiX } from 'react-icons/fi';
import { Button, IconButton } from '@/components/ui';
import { CLOUD_PROVIDER_LABEL, type CloudItem, type CloudProviderId } from '@/services/cloudFilesService';
import type { CloudSource } from './cloudSources';
import { extractErrorMessage } from '@/utils/errors';
import { extensionOf, formatBytes } from './cloudFormat';
import styles from './cloudFiles.module.css';

// What runs is never uploaded (the server refuses it too — common/file-names.ts).
const REFUSED = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jar', 'sh', 'app', 'dll', 'html', 'htm', 'hta', 'lnk']);

export interface UploadJob {
  id: string;
  file: File;
  /** The folder it goes to — chosen when it was added, whatever the browser shows later. */
  folder: CloudItem;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  progress: number;
  error?: string;
}

/**
 * Files going up to one account, one at a time (a batch never floods the provider), each with its own
 * progress, error and retry. `onUploaded` hears of every file that arrived.
 */
export function useCloudUploads(source: CloudSource, maxBytes: number, onUploaded: (item: CloudItem, folder: CloudItem) => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const running = useRef<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  const patch = (id: string, change: Partial<UploadJob>) => setJobs((all) => all.map((job) => (job.id === id ? { ...job, ...change } : job)));

  const add = useCallback(
    (files: File[], folder: CloudItem) => {
      const added: UploadJob[] = files.map((file, i) => {
        const id = `${Date.now()}-${i}-${file.name}`;
        const problem = REFUSED.has(extensionOf(file.name))
          ? 'This kind of file can’t be uploaded.'
          : file.size > maxBytes
            ? `Larger than ${formatBytes(maxBytes)}.`
            : undefined;
        return { id, file, folder, state: problem ? 'failed' : 'waiting', progress: 0, error: problem };
      });
      setJobs((all) => [...all, ...added]);
    },
    [maxBytes],
  );

  useEffect(() => {
    if (running.current) return;
    const next = jobs.find((job) => job.state === 'waiting');
    if (!next) return;
    running.current = next.id;
    const controller = new AbortController();
    controllers.current.set(next.id, controller);
    patch(next.id, { state: 'uploading', progress: 0, error: undefined });
    if (!source.upload) {
      patch(next.id, { state: 'failed', error: `Uploading isn’t possible here.` });
      running.current = null;
      return;
    }
    source
      .upload(next.folder.id, next.file, (progress) => patch(next.id, { progress }), controller.signal)
      .then((item) => {
        patch(next.id, { state: 'done', progress: 100 });
        uploaded.current(item, next.folder);
      })
      .catch((error) => patch(next.id, { state: 'failed', error: controller.signal.aborted ? 'Cancelled.' : extractErrorMessage(error) }))
      .finally(() => {
        controllers.current.delete(next.id);
        running.current = null;
        // Wakes the effect for the next waiting file.
        setJobs((all) => [...all]);
      });
  }, [jobs, source]);

  const retry = (id: string) => patch(id, { state: 'waiting', progress: 0, error: undefined });
  const cancel = (id: string) => {
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    else setJobs((all) => all.filter((job) => job.id !== id));
  };
  const clear = () => setJobs((all) => all.filter((job) => job.state === 'uploading' || job.state === 'waiting'));
  return { jobs, add, retry, cancel, clear };
}

export function CloudUploadQueue({ provider, uploads }: { provider: CloudProviderId; uploads: ReturnType<typeof useCloudUploads> }) {
  const { jobs, retry, cancel, clear } = uploads;
  if (jobs.length === 0) return null;
  const busy = jobs.filter((job) => job.state === 'uploading' || job.state === 'waiting').length;
  const failed = jobs.filter((job) => job.state === 'failed').length;
  return (
    <section className={styles.queue} aria-live="polite" aria-label="Uploads">
      <div className={styles.queueHead}>
        <span>
          {busy > 0 ? `Uploading to ${CLOUD_PROVIDER_LABEL[provider]} · ${busy} left` : failed > 0 ? `${failed} upload${failed === 1 ? '' : 's'} failed` : 'Uploads finished'}
        </span>
        {busy === 0 && (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
        )}
      </div>
      {jobs.map((job) => (
        <div key={job.id} className={styles.queueItem}>
          <span className={styles.queueName} title={`${job.file.name} → ${job.folder.name}`}>
            {job.file.name} <span className={styles.note}>→ {job.folder.name}</span>
          </span>
          <span className={styles.queueState}>
            {job.state === 'done' ? (
              <>
                <FiCheck aria-hidden /> Uploaded
              </>
            ) : job.state === 'failed' ? (
              <>
                {job.error !== 'This kind of file can’t be uploaded.' && !job.error?.startsWith('Larger than') && (
                  <IconButton size="sm" icon={<FiRotateCw />} label={`Retry ${job.file.name}`} onClick={() => retry(job.id)} />
                )}
                <IconButton size="sm" icon={<FiX />} label={`Remove ${job.file.name}`} onClick={() => cancel(job.id)} />
              </>
            ) : (
              <>
                {/* 100% has reached HaiVE; it then still goes on to the provider. */}
                {job.state === 'waiting' ? 'Waiting' : job.progress < 100 ? `${job.progress}%` : `Saving in ${CLOUD_PROVIDER_LABEL[provider]}…`}
                <IconButton size="sm" icon={<FiX />} label={`Cancel ${job.file.name}`} onClick={() => cancel(job.id)} />
              </>
            )}
          </span>
          <div className={clsx(styles.progress, job.state === 'done' && styles.progressDone, job.state === 'failed' && styles.progressFailed)}>
            <span style={{ width: `${job.state === 'failed' ? 100 : job.progress}%` }} />
          </div>
          {job.error && <span className={styles.queueError}>{job.error}</span>}
        </div>
      ))}
    </section>
  );
}
