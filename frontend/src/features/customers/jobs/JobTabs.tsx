import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  FiCheckSquare,
  FiDownload,
  FiEdit2,
  FiEdit3,
  FiImage,
  FiLayers,
  FiMessageSquare,
  FiPaperclip,
  FiPlus,
  FiShoppingCart,
  FiTrash2,
  FiTruck,
  FiUploadCloud,
  FiUser,
} from 'react-icons/fi';
import type { IconType } from 'react-icons';
import clsx from 'clsx';
import { CloudPickButton } from '@/components/cloud-files';
import { Button } from '@/components/ui';
import {
  customerJobsService,
  type JobDetail,
  type JobEntryInput,
  type JobStatusOption,
} from '@/services/customerJobsService';
import type { CustomerFile, CustomerWorkspace } from '@/services/customersService';
import { formatRelativeTime } from '@/utils/date';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate, formatMoney } from '../format';
import { fileSize, Loaded } from '../panel/WorkspaceTabs';
import detailStyles from '../customer-detail.module.css';
import panelStyles from '../panel/panel.module.css';
import type { RunJobChange } from './JobPanel';
import styles from './jobs.module.css';

const dash = '—';
const failed = (err: unknown) => toast.error(extractErrorMessage(err), { duration: 8_000 });
// The middle of the chosen day, so it is that day wherever it is read.
const noonOf = (day: string) => dayjs(day).hour(12).minute(0).second(0).millisecond(0).toISOString();

// ---- Job detail: who it is for, and what is in it ----------------------------------------

export function JobDetailTab({
  job,
  busy,
  onItemStatus,
  onOpenCustomer,
}: {
  job: JobDetail;
  busy: boolean;
  onItemStatus: (index: number, status: string) => void;
  onOpenCustomer: (customerId: string, quotationId?: string) => void;
}) {
  const money = (amount: number) => formatMoney(amount, job.currency);
  const { contact } = job;
  const customerId = job.customer.id;
  const done = job.items.filter((item) => item.status === 'done').length;
  return (
    <>
      <section className={detailStyles.section}>
        <h3>Customer information</h3>
        <div className={panelStyles.infoCard}>
          <dl className={panelStyles.infoGrid}>
            <div>
              <dt>Company</dt>
              <dd>{contact.company ?? dash}</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>{contact.contact ?? contact.name}</dd>
            </div>
            <div className={styles.infoSpan2}>
              <dt>Email</dt>
              <dd>
                {contact.email ? (
                  <a className={styles.plainLink} href={`mailto:${contact.email}`}>
                    {contact.email}
                  </a>
                ) : (
                  dash
                )}
              </dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>
                {contact.phone ? (
                  <a className={styles.plainLink} href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}>
                    {contact.phone}
                  </a>
                ) : (
                  dash
                )}
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{job.owner ?? dash}</dd>
            </div>
            <div>
              <dt>Made from</dt>
              <dd>
                {customerId ? (
                  <button
                    type="button"
                    className={panelStyles.textButton}
                    title="Open the quotation on the customer"
                    onClick={() => onOpenCustomer(customerId, job.quotationId)}
                  >
                    Quotation {job.quotationNumber ?? ''}
                  </button>
                ) : (
                  `Quotation ${job.quotationNumber ?? ''}`
                )}
                {job.quotationSource ? ` · ${job.quotationSource}` : ''}
              </dd>
            </div>
            <div>
              <dt>Quotation amount</dt>
              <dd>{money(job.amount)}</dd>
            </div>
            <div>
              <dt>Converted</dt>
              <dd>
                {formatDate(job.createdAt)} by {job.createdBy}
              </dd>
            </div>
          </dl>
          {customerId && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leftIcon={<FiUser />}
              className={styles.selfStart}
              onClick={() => onOpenCustomer(customerId)}
            >
              Open customer
            </Button>
          )}
        </div>
      </section>

      <section className={detailStyles.section}>
        <h3>
          Product information
          {job.items.length > 0 && (
            <span className={detailStyles.sectionCount}>
              {done} of {job.items.length} done · as on the quotation when it became a job
            </span>
          )}
        </h3>
        {job.items.length === 0 ? (
          <p className={detailStyles.muted}>
            The quotation held no items{job.quotationSource ? ` in ${job.quotationSource}` : ''} — only its total,{' '}
            {money(job.amount)}.
          </p>
        ) : (
          <>
            <div className={detailStyles.docWrap}>
              <table className={clsx(detailStyles.docTable, detailStyles.stackTable, detailStyles.stackThree)}>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className={detailStyles.num}>
                      Quantity
                    </th>
                    <th scope="col" className={detailStyles.num}>
                      Rate
                    </th>
                    <th scope="col" className={detailStyles.num}>
                      Total
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.items.map((item, index) => (
                    <tr key={`${item.name}-${index}`}>
                      <td>
                        <strong>{item.name}</strong>
                        {item.description && (
                          <div className={clsx(detailStyles.cellSub, panelStyles.lineDetail)} title={item.description}>
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td data-label="Quantity" className={detailStyles.num}>
                        {item.quantity.toLocaleString()}
                      </td>
                      <td data-label="Rate" className={detailStyles.num}>
                        {money(item.unitPrice)}
                      </td>
                      <td data-label="Total" className={detailStyles.num}>
                        {money(item.total)}
                      </td>
                      <td data-label="Status" className={detailStyles.stackWide}>
                        <StatusSelect
                          label={`Status of ${item.name}`}
                          value={item.status}
                          tone={item.tone}
                          options={job.options.items}
                          disabled={busy}
                          onChange={(status) => onItemStatus(index, status)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className={panelStyles.totals}>
              {job.subtotal !== null && (
                <div>
                  <dt>Items</dt>
                  <dd>{money(job.subtotal)}</dd>
                </div>
              )}
              {job.charges.map((charge, n) => (
                <div key={`${charge.name}-${n}`}>
                  <dt>{charge.name}</dt>
                  <dd>{money(charge.amount)}</dd>
                </div>
              ))}
              <div className={panelStyles.totalMain}>
                <dt>Quotation total</dt>
                <dd>{money(job.amount)}</dd>
              </div>
            </dl>
          </>
        )}
      </section>
    </>
  );
}

// A short status as a dropdown that carries its colour.
function StatusSelect({
  label,
  value,
  tone,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  tone: string;
  options: JobStatusOption[];
  disabled?: boolean;
  onChange: (status: string) => void;
}) {
  return (
    <select
      aria-label={label}
      className={clsx(styles.statusSelect, styles[`select_${tone}`])}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.status} value={option.status}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ---- Purchase orders and shipping: two lists kept the same way ---------------------------

interface EntryField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  placeholder?: string;
  maxLength?: number;
  // Takes the whole row of the form.
  wide?: boolean;
}

const ENTRIES = {
  orders: {
    list: 'purchase-orders' as const,
    source: 'purchaseOrders' as const,
    options: 'purchaseOrders' as const,
    title: 'Purchase orders',
    one: 'purchase order',
    intro: 'What has to be bought for this job — blanks, thread, transfers — and where each order stands.',
    empty: 'Nothing has been ordered for this job yet.',
    add: 'Add purchase order',
    fields: [
      { key: 'vendor', label: 'Ordered from', type: 'text', placeholder: 'e.g. Tiruppur Knits', maxLength: 120 },
      { key: 'description', label: 'What', type: 'text', placeholder: 'e.g. 250 navy polos, blank', maxLength: 500 },
      { key: 'amount', label: 'Amount', type: 'number', placeholder: '0' },
      { key: 'reference', label: 'Reference', type: 'text', placeholder: 'PO number', maxLength: 80 },
      { key: 'orderedAt', label: 'Ordered on', type: 'date' },
      { key: 'expectedAt', label: 'Expected on', type: 'date' },
      { key: 'receivedAt', label: 'Received on', type: 'date' },
    ] as EntryField[],
  },
  shipping: {
    list: 'shipments' as const,
    source: 'shipments' as const,
    options: 'shipments' as const,
    title: 'Shipping',
    one: 'shipment',
    intro: 'How the finished job reaches the customer: who carries it, its tracking number, and when it went.',
    empty: 'Nothing has been shipped for this job yet.',
    add: 'Add shipment',
    fields: [
      { key: 'carrier', label: 'Courier', type: 'text', placeholder: 'e.g. Blue Dart', maxLength: 80 },
      { key: 'trackingNumber', label: 'Tracking number', type: 'text', maxLength: 80 },
      { key: 'shippedAt', label: 'Shipped on', type: 'date' },
      { key: 'deliveredAt', label: 'Delivered on', type: 'date' },
      { key: 'note', label: 'Note', type: 'text', placeholder: 'e.g. Two cartons', maxLength: 500, wide: true },
    ] as EntryField[],
  },
};

type Entry = Record<string, unknown> & { id: string; status: string; tone: string; addedBy: string; at: string };
type Values = Record<string, string>;

// What a form holds, as what the server stores. On a change, an emptied box clears the field (null).
function toInput(fields: EntryField[], values: Values, clearing: boolean): JobEntryInput {
  const input: JobEntryInput = {};
  for (const field of fields) {
    const written = (values[field.key] ?? '').trim();
    if (!written) {
      if (clearing) input[field.key] = null;
    } else if (field.type === 'number') input[field.key] = Number(written);
    else if (field.type === 'date') input[field.key] = noonOf(written);
    else input[field.key] = written;
  }
  return input;
}

const valuesOf = (fields: EntryField[], entry?: Entry): Values =>
  Object.fromEntries(
    fields.map((field) => {
      const value = entry?.[field.key];
      if (value === undefined || value === null) return [field.key, ''];
      return [field.key, field.type === 'date' ? dayjs(String(value)).format('YYYY-MM-DD') : String(value)];
    }),
  );

function EntryForm({
  fields,
  initial,
  submit,
  saving,
  onSubmit,
  onCancel,
}: {
  fields: EntryField[];
  initial: Values;
  submit: string;
  saving: boolean;
  onSubmit: (values: Values) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [main] = fields;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if ((values[main.key] ?? '').trim() && !saving) onSubmit(values);
  };
  return (
    <form className={styles.entryForm} onSubmit={send}>
      {fields.map((field) => (
        <label key={field.key} className={clsx(panelStyles.fieldLabel, field.wide && styles.entryWide)}>
          <span>{field.label}</span>
          <input
            className={panelStyles.field}
            type={field.type}
            value={values[field.key] ?? ''}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            {...(field.type === 'number' ? { min: 0, step: 'any', inputMode: 'decimal' as const } : {})}
            onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
          />
        </label>
      ))}
      <div className={styles.entryActions}>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          leftIcon={onCancel ? undefined : <FiPlus />}
          loading={saving}
          disabled={!(values[main.key] ?? '').trim()}
        >
          {submit}
        </Button>
      </div>
    </form>
  );
}

export function EntriesTab({
  kind,
  job,
  busy,
  run,
}: {
  kind: keyof typeof ENTRIES;
  job: JobDetail;
  busy: boolean;
  run: RunJobChange;
}) {
  const spec = ENTRIES[kind];
  const [main, ...rest] = spec.fields;
  const entries = job[spec.source] as unknown as Entry[];
  const options = job.options[spec.options];
  const [editing, setEditing] = useState<string | null>(null);
  // A new form after each one added: its boxes start empty again.
  const [added, setAdded] = useState(0);
  const money = (amount: number) => formatMoney(amount, job.currency);

  const add = async (values: Values) => {
    if (await run(() => customerJobsService.addEntry(job.id, spec.list, toInput(spec.fields, values, false))))
      setAdded((n) => n + 1);
  };
  const save = async (entry: Entry, values: Values) => {
    if (
      await run(() => customerJobsService.updateEntry(job.id, spec.list, entry.id, toInput(spec.fields, values, true)))
    )
      setEditing(null);
  };
  const remove = (entry: Entry) => {
    if (!window.confirm(`Delete this ${spec.one} (${String(entry[main.key])})?`)) return;
    void run(() => customerJobsService.removeEntry(job.id, spec.list, entry.id));
  };
  const shown = (entry: Entry, field: EntryField) => {
    const value = entry[field.key];
    if (value === undefined || value === null || value === '') return null;
    if (field.type === 'date') return formatDate(String(value));
    if (field.type === 'number') return money(Number(value));
    return String(value);
  };

  return (
    <>
      <section className={detailStyles.section}>
        <h3>{spec.add}</h3>
        <EntryForm
          key={added}
          fields={spec.fields}
          initial={valuesOf(spec.fields)}
          submit={spec.add}
          saving={busy}
          onSubmit={(values) => void add(values)}
        />
        <p className={panelStyles.hint}>{spec.intro} Saved in HaiVE, not in your CRM.</p>
      </section>

      <section className={detailStyles.section}>
        <h3>
          {spec.title} <span className={detailStyles.sectionCount}>{entries.length}</span>
        </h3>
        {entries.length === 0 ? (
          <p className={detailStyles.muted}>{spec.empty}</p>
        ) : (
          <ul className={styles.entries}>
            {entries.map((entry) =>
              editing === entry.id ? (
                <li key={entry.id} className={styles.entry}>
                  <EntryForm
                    fields={spec.fields}
                    initial={valuesOf(spec.fields, entry)}
                    submit="Save"
                    saving={busy}
                    onSubmit={(values) => void save(entry, values)}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li key={entry.id} className={styles.entry}>
                  <div className={styles.entryHead}>
                    <div className={panelStyles.listMain}>
                      <strong>{String(entry[main.key])}</strong>
                      <span>
                        added by {entry.addedBy} {formatRelativeTime(entry.at)}
                      </span>
                    </div>
                    <StatusSelect
                      label={`Status of the ${spec.one} ${String(entry[main.key])}`}
                      value={entry.status}
                      tone={entry.tone}
                      options={options}
                      disabled={busy}
                      onChange={(status) =>
                        void run(() => customerJobsService.updateEntry(job.id, spec.list, entry.id, { status }))
                      }
                    />
                    <button
                      type="button"
                      className={panelStyles.iconLink}
                      aria-label={`Change the ${spec.one} ${String(entry[main.key])}`}
                      title="Change"
                      onClick={() => setEditing(entry.id)}
                    >
                      <FiEdit2 aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={panelStyles.iconLink}
                      aria-label={`Delete the ${spec.one} ${String(entry[main.key])}`}
                      title="Delete"
                      onClick={() => remove(entry)}
                    >
                      <FiTrash2 aria-hidden />
                    </button>
                  </div>
                  {rest.some((field) => shown(entry, field)) && (
                    <dl className={styles.entryFacts}>
                      {rest.map((field) => {
                        const value = shown(entry, field);
                        return value ? (
                          <div key={field.key} className={clsx(field.wide && styles.entryWide)}>
                            <dt>{field.label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ) : null;
                      })}
                    </dl>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </>
  );
}

// ---- Proofs: the artwork, and whether it is approved ---------------------------------------

export function ProofsTab({
  jobId,
  options,
  workspace,
  onChanged,
}: {
  jobId: string;
  options: JobStatusOption[];
  workspace: UseQueryResult<CustomerWorkspace>;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const limits = workspace.data?.limits;
  const api = customerJobsService.workspaceApi(jobId);

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
        await customerJobsService.uploadProof(jobId, file);
        added += 1;
      } catch (err) {
        toast.error(`${file.name}: ${extractErrorMessage(err)}`, { duration: 8_000 });
      }
      setUploading((left) => left - 1);
    }
    setUploading(0);
    if (added > 0) {
      toast.success(added === 1 ? 'Proof uploaded' : `${added} proofs uploaded`);
      onChanged();
    }
  };
  const act = async (fileId: string, run: () => Promise<unknown>, done?: string) => {
    setBusyId(fileId);
    try {
      await run();
      if (done) toast.success(done);
      onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setBusyId(null);
    }
  };
  const download = async (file: CustomerFile) => {
    try {
      const url = URL.createObjectURL(await api.downloadFile(file.id));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      failed(err);
    }
  };
  const remove = (file: CustomerFile) => {
    if (!window.confirm(`Delete the proof ${file.name}? This can’t be undone.`)) return;
    void act(file.id, () => api.removeFile(file.id));
  };

  return (
    <>
      <div
        className={clsx(panelStyles.dropZone, over && panelStyles.dropZoneOver)}
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
          <strong>Artwork proofs for this job</strong>
          <span>
            Drop them here or choose them, then mark each one approved or as needing changes
            {limits ? ` · up to ${fileSize(limits.maxFileBytes)} each` : ''}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={uploading > 0}
          onClick={() => input.current?.click()}
        >
          {uploading > 0 ? `Uploading ${uploading}…` : 'Upload proof'}
        </Button>
        <CloudPickButton label="From the cloud" maxBytes={limits?.maxFileBytes} disabled={uploading > 0} onPick={(files) => upload(files)} />
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose proofs to upload"
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      <Loaded workspace={workspace}>
        {({ files, canManage }) => {
          const proofs = files.filter((file) => file.kind === 'proof');
          return proofs.length === 0 ? (
            <p className={detailStyles.muted}>No proof has been uploaded for this job yet.</p>
          ) : (
            <ul className={styles.entries}>
              {proofs.map((proof) => (
                <ProofRow
                  key={`${proof.id}-${proof.proofStatus}-${proof.proofNote ?? ''}`}
                  proof={proof}
                  options={options}
                  busy={busyId === proof.id}
                  canRemove={proof.mine || canManage}
                  onSet={(status, note) =>
                    void act(
                      proof.id,
                      () => customerJobsService.setProof(jobId, proof.id, status, note),
                      note !== undefined && status === proof.proofStatus ? 'Note saved' : undefined,
                    )
                  }
                  onDownload={() => void download(proof)}
                  onRemove={() => remove(proof)}
                />
              ))}
            </ul>
          );
        }}
      </Loaded>
    </>
  );
}

function ProofRow({
  proof,
  options,
  busy,
  canRemove,
  onSet,
  onDownload,
  onRemove,
}: {
  proof: CustomerFile;
  options: JobStatusOption[];
  busy: boolean;
  canRemove: boolean;
  onSet: (status: string, note?: string) => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const status = proof.proofStatus ?? 'awaiting';
  const [note, setNote] = useState(proof.proofNote ?? '');
  const tone = options.find((o) => o.status === status)?.tone ?? 'none';
  return (
    <li className={styles.entry}>
      <div className={styles.entryHead}>
        <FiImage aria-hidden className={panelStyles.listIcon} />
        <div className={panelStyles.listMain}>
          <strong>{proof.name}</strong>
          <span>
            {fileSize(proof.size)} · uploaded by {proof.uploadedBy} {formatRelativeTime(proof.at)}
          </span>
        </div>
        <StatusSelect
          label={`Approval of ${proof.name}`}
          value={status}
          tone={tone}
          options={options}
          disabled={busy}
          // Moving away from "Changes needed" drops what had to change; moving to it keeps what is written.
          onChange={(next) => onSet(next, next === 'changes' ? note.trim() : undefined)}
        />
        <button
          type="button"
          className={panelStyles.iconLink}
          aria-label={`Download ${proof.name}`}
          title="Download"
          onClick={onDownload}
        >
          <FiDownload aria-hidden />
        </button>
        {canRemove && (
          <button
            type="button"
            className={panelStyles.iconLink}
            aria-label={`Delete ${proof.name}`}
            title="Delete proof"
            onClick={onRemove}
          >
            <FiTrash2 aria-hidden />
          </button>
        )}
      </div>
      {status === 'changes' && (
        <form
          className={styles.proofNote}
          onSubmit={(event) => {
            event.preventDefault();
            onSet('changes', note.trim());
          }}
        >
          <input
            aria-label={`What needs to change on ${proof.name}`}
            className={panelStyles.field}
            placeholder="What needs to change? e.g. Logo is too small"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={note.trim() === (proof.proofNote ?? '')}
          >
            Save note
          </Button>
        </form>
      )}
    </li>
  );
}

// ---- Activity: everything that happened on the job, with who did it ------------------------

const EVENT_ICON: [RegExp, IconType][] = [
  [/^Job created/, FiLayers],
  [/^Comment/, FiMessageSquare],
  [/^Task/, FiCheckSquare],
  [/^(File|Proof|Changes needed)/, FiPaperclip],
  [/^Purchase order/, FiShoppingCart],
  [/^Shipment/, FiTruck],
];

export function JobActivityTab({ job }: { job: JobDetail }) {
  if (job.history.length === 0) return <p className={detailStyles.muted}>Nothing has happened on this job yet.</p>;
  return (
    <ol className={detailStyles.timeline}>
      {job.history.map((event, n) => {
        const Icon = EVENT_ICON.find(([pattern]) => pattern.test(event.text))?.[1] ?? FiEdit3;
        return (
          <li key={`${event.at}-${n}`} className={detailStyles.timelineItem}>
            <span className={detailStyles.timelineIcon}>
              <Icon aria-hidden />
            </span>
            <div className={detailStyles.timelineBody}>
              <div className={detailStyles.timelineHead}>
                <strong>{event.text}</strong>
                <time dateTime={event.at} title={formatDate(event.at)}>
                  {formatRelativeTime(event.at)}
                </time>
              </div>
              <div className={detailStyles.sub}>{event.by}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
