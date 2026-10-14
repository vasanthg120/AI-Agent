import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import type { UseQueryResult } from '@tanstack/react-query';
import { FiAlertCircle, FiDownload, FiFile, FiPlus, FiTrash2, FiUploadCloud } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui';
import { ROUTES } from '@/constants/routes';
import type { CustomerTask, CustomerWorkspace, WorkspaceApi } from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate } from '../format';
import { JobTag } from '../jobs/JobTag';
import detailStyles from '../customer-detail.module.css';
import styles from './panel.module.css';

// What the team attaches to a customer — comments, tasks, files. They are saved
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

// When a task is due, in the words the board uses.
function dueLabel(task: CustomerTask): { label: string; variant: 'danger' | 'warning' | 'info' | 'neutral' } | null {
  if (!task.dueDate) return null;
  if (task.status === 'done') return { label: formatDate(task.dueDate), variant: 'neutral' };
  if (task.overdue) return { label: `Overdue · ${formatDate(task.dueDate)}`, variant: 'danger' };
  if (dayjs(task.dueDate).isSame(dayjs(), 'day')) return { label: 'Due today', variant: 'warning' };
  return { label: `Due ${formatDate(task.dueDate)}`, variant: 'info' };
}

export function TasksTab({ api, workspace, onChanged, of = 'customer', onOpenJob }: WorkspaceTabProps) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await api.addTask({
        title: title.trim(),
        // The middle of the chosen day, so it is that day wherever it is read.
        ...(dueDate ? { dueDate: dayjs(dueDate).hour(12).toISOString() } : {}),
        ...(assigneeId ? { assigneeId } : {}),
      });
      setTitle('');
      setDueDate('');
      onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setSaving(false);
    }
  };
  const act = async (taskId: string, run: () => Promise<unknown>) => {
    setBusyId(taskId);
    try {
      await run();
      onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setBusyId(null);
    }
  };
  const toggle = (task: CustomerTask) =>
    act(task.id, () => api.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' }));
  const remove = (task: CustomerTask) => {
    if (!window.confirm(`Delete the task “${task.title}”?`)) return;
    void act(task.id, () => api.removeTask(task.id));
  };

  return (
    <>
      <form className={styles.taskForm} onSubmit={(e) => void add(e)}>
        <input
          aria-label="Task"
          className={styles.field}
          placeholder={
            of === 'job'
              ? 'What needs doing on this job? e.g. Order the blanks'
              : 'What needs doing? e.g. Call back about the logo size'
          }
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className={styles.fieldLabel}>
          <span>Due</span>
          <input
            type="date"
            className={styles.field}
            value={dueDate}
            min={dayjs().format('YYYY-MM-DD')}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
        <label className={styles.fieldLabel}>
          <span>For</span>
          <select className={styles.field} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Anyone</option>
            {(workspace.data?.assignees ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" leftIcon={<FiPlus />} loading={saving} disabled={!title.trim()}>
          Add task
        </Button>
      </form>
      <p className={styles.hint}>
        {of === 'job'
          ? 'A task that is due also shows on the customer, under Follow-up. Tasks are saved in HaiVE, not in your CRM.'
          : 'A task that is due shows on the board under Follow-up. Tasks are saved in HaiVE, not in your CRM.'}
      </p>

      <Loaded workspace={workspace}>
        {({ tasks, linkedTasks, canManage }) => {
          const open = tasks.filter((t) => t.status === 'open');
          const done = tasks.filter((t) => t.status === 'done');
          const row = (task: CustomerTask) => {
            const due = dueLabel(task);
            return (
              <li key={task.id} className={clsx(styles.task, task.status === 'done' && styles.taskDone)}>
                <input
                  type="checkbox"
                  aria-label={task.status === 'done' ? `Reopen “${task.title}”` : `Mark “${task.title}” done`}
                  // Ticks at once, then waits for the server: a box that hesitates reads as a click that missed.
                  checked={(task.status === 'done') !== (busyId === task.id)}
                  disabled={busyId === task.id}
                  onChange={() => void toggle(task)}
                />
                <div className={styles.listMain}>
                  <strong>{task.title}</strong>
                  <span>
                    {[
                      task.assignee ? `For ${task.assignee}` : 'For anyone',
                      `added by ${task.createdBy} ${formatRelativeTime(task.at)}`,
                      task.completedAt ? `done ${formatRelativeTime(task.completedAt)}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                {/* Where there is no room beside the title, these drop under it together. */}
                <div className={styles.listEnd}>
                  {jobOf(task, onOpenJob)}
                  {due && <Badge variant={due.variant}>{due.label}</Badge>}
                  {(task.mine || canManage) && (
                    <button
                      type="button"
                      className={styles.iconLink}
                      aria-label={`Delete “${task.title}”`}
                      title="Delete task"
                      onClick={() => remove(task)}
                    >
                      <FiTrash2 aria-hidden />
                    </button>
                  )}
                </div>
              </li>
            );
          };
          return (
            <>
              {tasks.length === 0 && <p className={detailStyles.muted}>No tasks for this {of} yet.</p>}
              {open.length > 0 && (
                <section className={detailStyles.section}>
                  <h3>
                    To do <span className={detailStyles.sectionCount}>{open.length}</span>
                  </h3>
                  <ul className={styles.list}>{open.map(row)}</ul>
                </section>
              )}
              {done.length > 0 && (
                <section className={detailStyles.section}>
                  <h3>
                    Done <span className={detailStyles.sectionCount}>{done.length}</span>
                  </h3>
                  <ul className={styles.list}>{done.map(row)}</ul>
                </section>
              )}
              {linkedTasks.length > 0 && (
                <section className={detailStyles.section}>
                  <h3>
                    From the To-Do list <span className={detailStyles.sectionCount}>{linkedTasks.length}</span>
                  </h3>
                  <ul className={styles.list}>
                    {linkedTasks.map((task) => (
                      <li key={task.id} className={styles.listRow}>
                        <div className={styles.listMain}>
                          <strong>{task.title}</strong>
                          <span>
                            Daily report of {formatDate(task.date)} · {task.priority} priority
                          </span>
                        </div>
                        <Badge variant={task.status === 'done' ? 'success' : 'neutral'}>
                          {task.status === 'done' ? 'Done' : task.status === 'in_progress' ? 'In progress' : 'To do'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className={styles.textButton} onClick={() => navigate(ROUTES.todoEod)}>
                    Open the To-Do list
                  </button>
                </section>
              )}
            </>
          );
        }}
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
