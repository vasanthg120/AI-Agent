import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import toast from 'react-hot-toast';
import type { UseQueryResult } from '@tanstack/react-query';
import { FiAlertCircle, FiDownload, FiFile, FiTrash2, FiUploadCloud } from 'react-icons/fi';
import clsx from 'clsx';
import { CloudPickButton, CloudSourceBadge } from '@/components/cloud-files';
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui';
import type { CustomerWorkspace, WorkspaceApi } from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate } from '../format';
import { JobTag } from '../jobs/JobTag';
import detailStyles from '../customer-detail.module.css';
import styles from './panel.module.css';

// What the team attaches to a customer — comments and files. They are saved
// in HaiVE only (nothing is written to a CRM), and they stay with the customer
// when a sync changes the row. The same tabs serve a job: what is attached to
// a job is its customer's own, tagged with the job.

interface WorkspaceTabProps {
  // Where the writing goes: a customer, or one of their jobs.
  api: WorkspaceApi;
  workspace: UseQueryResult<CustomerWorkspace>;
  // Something was added, changed or removed: the board and the timeline should catch up.
  onChanged: () => void;
  // Whose tabs these are; the wording follows.
  of?: 'customer' | 'job';
  // On a customer, what belongs to a job names it — and opens it.
  onOpenJob?: (jobId: string, number?: string) => void;
}

// The job something belongs to, where it is shown on its customer.
const jobOf = (item: { jobId?: string; jobNumber?: string }, onOpenJob?: (jobId: string, number?: string) => void) =>
  item.jobId && item.jobNumber ? <JobTag job={{ id: item.jobId, number: item.jobNumber }} onOpen={onOpenJob} /> : null;

const failed = (err: unknown) => toast.error(extractErrorMessage(err), { duration: 8_000 });

// While the comments, tasks and files load — or if they could not be loaded.
export function Loaded({
  workspace,
  children,
}: {
  workspace: UseQueryResult<CustomerWorkspace>;
  children: (data: CustomerWorkspace) => ReactNode;
}) {
  if (workspace.isLoading) return <Skeleton height={140} />;
  if (workspace.isError || !workspace.data)
    return (
      <EmptyState
        compact
        icon={FiAlertCircle}
        title="Couldn’t load this"
        description={extractErrorMessage(workspace.error)}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => void workspace.refetch()}>
            Try again
          </Button>
        }
      />
    );
  return <>{children(workspace.data)}</>;
}

export function CommentsTab({ api, workspace, onChanged, of = 'customer', onOpenJob }: WorkspaceTabProps) {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const add = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!body.trim() || saving) return;
    setSaving(true);
    try {
      await api.addNote(body.trim());
      setBody('');
      onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (noteId: string) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api.removeNote(noteId);
      onChanged();
    } catch (err) {
      failed(err);
    }
  };
  return (
    <>
      <form className={styles.composer} onSubmit={(e) => void add(e)}>
        <textarea
          aria-label="Write a comment"
          placeholder={
            of === 'job'
              ? 'Write a comment about this job — what was agreed, what to watch for…'
              : 'Write a comment for your team — what was agreed on the phone, what to watch for…'
          }
          value={body}
          maxLength={4000}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
          }}
        />
        <div className={styles.composerFoot}>
          <span>Only your team sees comments. They are saved in HaiVE, not in your CRM.</span>
          <Button type="submit" size="sm" loading={saving} disabled={!body.trim()}>
            Add comment
          </Button>
        </div>
      </form>
      <Loaded workspace={workspace}>
        {({ notes, canManage }) =>
          notes.length === 0 ? (
            <p className={detailStyles.muted}>No comments yet. The first one is yours.</p>
          ) : (
            <ul className={styles.notes}>
              {notes.map((note) => (
                <li key={note.id} className={styles.note}>
                  <div className={styles.noteHead}>
                    <strong>{note.author}</strong>
                    {jobOf(note, onOpenJob)}
                    <time dateTime={note.at} title={formatDate(note.at)}>
                      {formatRelativeTime(note.at)}
                    </time>
                    {(note.mine || canManage) && (
                      <button
                        type="button"
                        className={styles.iconLink}
                        aria-label="Delete comment"
                        title="Delete comment"
                        onClick={() => void remove(note.id)}
                      >
                        <FiTrash2 aria-hidden />
                      </button>
                    )}
                  </div>
                  <p>{note.body}</p>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </>
  );
}

export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function FilesTab({ api, workspace, onChanged, of = 'customer', onOpenJob }: WorkspaceTabProps) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const limits = workspace.data?.limits;

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    const fits = files.filter((file) => !limits || file.size <= limits.maxFileBytes);
    for (const file of files.filter((f) => !fits.includes(f)))
      toast.error(`${file.name} is larger than ${fileSize(limits!.maxFileBytes)} and wasn’t uploaded.`, {
        duration: 8_000,
      });
    setUploading(fits.length);
    let added = 0;
    for (const file of fits) {
      try {
        await api.uploadFile(file);
        added += 1;
      } catch (err) {
        toast.error(`${file.name}: ${extractErrorMessage(err)}`, { duration: 8_000 });
      }
      setUploading((left) => left - 1);
    }
    setUploading(0);
    if (added > 0) {
      toast.success(added === 1 ? 'File added' : `${added} files added`);
      onChanged();
    }
  };
  const download = async (fileId: string, name: string) => {
    try {
      const blob = await api.downloadFile(fileId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      failed(err);
    }
  };
  const remove = async (fileId: string, name: string) => {
    if (!window.confirm(`Delete ${name}? This can’t be undone.`)) return;
    try {
      await api.removeFile(fileId);
      onChanged();
    } catch (err) {
      failed(err);
    }
  };

  return (
    <>
      <div
        className={clsx(styles.dropZone, over && styles.dropZoneOver)}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload([...e.dataTransfer.files]);
        }}
      >
        <FiUploadCloud aria-hidden />
        <div>
          <strong>
            {of === 'job'
              ? 'Purchase orders, delivery notes, references — anything about this job'
              : 'Artwork, purchase orders, proofs — anything about this customer'}
          </strong>
          <span>
            Drop files here or choose them
            {limits ? ` · up to ${fileSize(limits.maxFileBytes)} each, ${limits.maxFiles} files per customer` : ''}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={uploading > 0}
          onClick={() => input.current?.click()}
        >
          {uploading > 0 ? `Uploading ${uploading}…` : 'Choose files'}
        </Button>
        {/* A copy of a Google Drive / OneDrive file, stored in HaiVE like one chosen here. */}
        <CloudPickButton label="From the cloud" maxBytes={limits?.maxFileBytes} disabled={uploading > 0} onPick={(files) => upload(files)} />
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose files to upload"
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      <Loaded workspace={workspace}>
        {({ files: every, canManage }) => {
          // A job's artwork proofs have a tab of their own there; on the customer they are listed with the rest.
          const files = of === 'job' ? every.filter((file) => file.kind !== 'proof') : every;
          return files.length === 0 ? (
            <p className={detailStyles.muted}>No files for this {of} yet.</p>
          ) : (
            <ul className={styles.list}>
              {files.map((file) => (
                <li key={file.id} className={styles.listRow}>
                  <FiFile aria-hidden className={styles.listIcon} />
                  <div className={styles.listMain}>
                    <strong>{file.name}</strong>
                    <span>
                      {fileSize(file.size)} · added by {file.uploadedBy} {formatRelativeTime(file.at)}
                    </span>
                  </div>
                  <div className={styles.listEnd}>
                    {file.copiedFrom && <CloudSourceBadge provider={file.copiedFrom} copied />}
                    {of === 'customer' && file.kind === 'proof' && <Badge variant="neutral">Proof</Badge>}
                    {jobOf(file, onOpenJob)}
                    <button
                      type="button"
                      className={styles.iconLink}
                      aria-label={`Download ${file.name}`}
                      title="Download"
                      onClick={() => void download(file.id, file.name)}
                    >
                      <FiDownload aria-hidden />
                    </button>
                    {(file.mine || canManage) && (
                      <button
                        type="button"
                        className={styles.iconLink}
                        aria-label={`Delete ${file.name}`}
                        title="Delete file"
                        onClick={() => void remove(file.id, file.name)}
                      >
                        <FiTrash2 aria-hidden />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </Loaded>
    </>
  );
}
