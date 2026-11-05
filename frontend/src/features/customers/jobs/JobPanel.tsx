import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FiAlertCircle,
  FiCheckCircle,
  FiChevronDown,
  FiEdit2,
  FiFileText,
  FiMail,
  FiPackage,
  FiPhone,
  FiPlusSquare,
  FiSlash,
  FiTrash2,
  FiUser,
  FiX,
} from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, Button, Drawer, Dropdown, EmptyState, Skeleton, Tabs } from '@/components/ui';
import type { DropdownItem } from '@/components/ui';
import {
  customerJobsService,
  type Job,
  type JobDetail,
  type JobDocumentKind,
  type JobStatusChip,
  type JobStatusColumn,
} from '@/services/customerJobsService';
import { quotesService } from '@/services/quotesService';
import { vendorsService } from '@/services/vendorsService';
import { extractErrorMessage } from '@/utils/errors';
import { formatDate } from '../format';
import { CommentsTab, FilesTab, TasksTab } from '../panel/WorkspaceTabs';
import { StageChip } from '../StageChip';
import panelStyles from '../panel/panel.module.css';
import { EntriesTab, JobActivityTab, JobDetailTab, JobInvoiceTab, ProofsTab } from './JobTabs';
import styles from './jobs.module.css';

export type JobPanelTab = 'detail' | 'orders' | 'proofs' | 'files' | 'comments' | 'tasks' | 'shipping' | 'credits' | 'invoice' | 'activity';

// What whoever opens the panel already knows about the job: shown at once, until the rest has loaded.
export interface JobPreview {
  number: string;
  title?: string;
  // The two lines under the name, when a board row was there to tell them.
  who?: string;
  facts?: string;
}

// The two lines under a job's name: who it is for, and where it came from. The same words whether they are
// read off a row of the board (before the job has loaded) or off the job itself.
export function jobHeadline(job: Job | JobDetail): { who: string; facts: string } {
  const contact = 'contact' in job ? (job.contact.contact ?? job.contact.name) : job.customer.name;
  const company = 'contact' in job ? job.contact.company : job.customer.company;
  return {
    who: [...new Set([company, contact].filter(Boolean))].join(' | '),
    facts: [
      job.quotationNumber ? `From quote ${job.quotationNumber}` : 'From a quotation',
      job.owner ? `Owner: ${job.owner}` : '',
      `Created ${formatDate(job.createdAt)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

// The eight statuses keep their place while the job loads, so nothing jumps when they arrive.
const STATUSES = 8;

// Section 16 (JobBoard spec) — the backend rejects these two Overall
// Status values outright with no proofFileId (see customer-jobs.service.ts's
// REMITTANCE_PROOF_REQUIRED); mirrored here only to decide when to open
// the file picker before calling setStatus at all, never to replace that
// server-side check.
const REMITTANCE_PROOF_REQUIRED = ['received', 'tbc_remittance_received'];

// A change to the job itself: the server answers with the job as it now is. Resolves to whether it was saved.
export type RunJobChange = (run: () => Promise<JobDetail>, done?: string) => Promise<boolean>;

// The middle of the chosen day, so it is that day wherever it is read.
const noonOf = (day: string) => dayjs(day).hour(12).minute(0).second(0).millisecond(0).toISOString();
const dayOf = (iso?: string) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '');

// One job in full, in a panel beside the board: its eight statuses and due
// date at the top — each status a menu — then what it is for and what is in
// it, what has to be bought, the artwork proofs, files, comments, tasks,
// shipping, and everything that happened. Saved in HaiVE only.
export function JobPanel({
  jobId,
  preview,
  handover,
  onClose,
  onOpenCustomer: openCustomerPanel,
}: {
  jobId: string | null;
  preview?: JobPreview;
  // This panel is taking over from the customer panel, or handing over to it: it changes in place.
  handover?: boolean;
  onClose: () => void;
  // The job's customer — optionally on the quotation the job was made from; and what the job knows of them.
  onOpenCustomer: (customerId: string, quotationId?: string, preview?: { name: string; company?: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<JobPanelTab>('detail');
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState('');
  const [inHands, setInHands] = useState('');
  const [pendingProofStatus, setPendingProofStatus] = useState<{ chip: JobStatusChip; column: JobStatusColumn; status: string } | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);
  const detailKey = ['customer-jobs', 'detail', jobId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: detailKey,
    queryFn: () => customerJobsService.get(jobId!),
    enabled: !!jobId,
  });
  // Comments, tasks, files and proofs: their counts sit on the tabs, so they load with the panel.
  const workspace = useQuery({
    queryKey: ['customer-jobs', 'workspace', jobId],
    queryFn: () => customerJobsService.workspace(jobId!),
    enabled: !!jobId,
  });
  // "Production" column's real Vendor picker — same list the Catalog/
  // SalesBoard pickers already use.
  const vendorOptions = useQuery({
    queryKey: ['vendors', 'picker'],
    queryFn: () => vendorsService.listPicker(),
    enabled: !!jobId,
    staleTime: 60_000,
  });

  useEffect(() => setTab('detail'), [jobId]);
  useEffect(() => setDue(dayOf(data?.dueDate)), [data?.dueDate, jobId]);
  useEffect(() => setInHands(dayOf(data?.inHandsDate)), [data?.inHandsDate, jobId]);

  // What changes on a job shows on the Job board — and on its customer: a job's task is a follow-up there,
  // and a finished job says so in their records.
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer-jobs'], exact: false, refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
  };
  const apply: RunJobChange = async (run, done) => {
    setBusy(true);
    try {
      const job = await run();
      queryClient.setQueryData<JobDetail>(detailKey, job);
      if (done) toast.success(done);
      void queryClient.invalidateQueries({ queryKey: ['customer-jobs', 'list'], exact: false, refetchType: 'active' });
      void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
      return true;
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (chip: JobStatusChip, column: JobStatusColumn, status: string | null) => {
    if (!jobId || (status ?? '') === chip.status) return;
    // Section 16 — this status asserts remittance was received, so a
    // proof file is required before the backend accepts it. Open the
    // file picker instead of changing the status directly; the actual
    // transition happens in handleProofFile once a file is chosen.
    if (chip.key === 'payment' && status && REMITTANCE_PROOF_REQUIRED.includes(status)) {
      setPendingProofStatus({ chip, column, status });
      proofInputRef.current?.click();
      return;
    }
    const label = column.options.find((o) => o.status === status)?.label;
    void apply(
      () => customerJobsService.setStatus(jobId, chip.key, status),
      label ? `${chip.title} set to ${label}` : `${chip.title} cleared`,
    );
  };
  const changeDue = (value: string) => {
    setDue(value);
    if (!jobId || value === dayOf(data?.dueDate)) return;
    // While a year is being typed the box passes through 0002, 0020, 0202: only a real date is saved.
    const year = Number(value.slice(0, 4));
    if (value && (year < 2000 || year > 2100)) return;
    void apply(
      () => customerJobsService.update(jobId, { dueDate: value ? noonOf(value) : null }),
      value ? `Due date set to ${formatDate(noonOf(value))}` : 'Due date removed',
    );
  };
  const changeInHands = (value: string) => {
    setInHands(value);
    if (!jobId || value === dayOf(data?.inHandsDate)) return;
    const year = Number(value.slice(0, 4));
    if (value && (year < 2000 || year > 2100)) return;
    void apply(
      () => customerJobsService.update(jobId, { inHandsDate: value ? noonOf(value) : null }),
      value ? `In Hands date set to ${formatDate(noonOf(value))}` : 'In Hands date removed',
    );
  };
  const changeProductionHouse = (vendorId: string) => {
    if (!jobId) return;
    void apply(
      () => customerJobsService.update(jobId, { productionHouseVendorId: vendorId || null }),
      vendorId ? undefined : 'Production house cleared',
    );
  };
  // Picked (or cancelled) the OS file dialog opened by setStatus above for
  // a remittance-required Overall Status value.
  const handleProofFile = async (file: File | undefined) => {
    const pending = pendingProofStatus;
    setPendingProofStatus(null);
    if (!jobId || !file || !pending) return;
    setBusy(true);
    try {
      const uploaded = await customerJobsService.workspaceApi(jobId).uploadFile(file);
      const label = pending.column.options.find((o) => o.status === pending.status)?.label;
      await apply(
        () => customerJobsService.setStatus(jobId, pending.chip.key, pending.status, uploaded.id),
        `${pending.column.title} set to ${label} (proof attached: ${uploaded.name})`,
      );
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    if (!jobId || !data) return;
    const title = window.prompt('Name of the job', data.title)?.trim();
    if (!title || title === data.title) return;
    void apply(() => customerJobsService.update(jobId, { title }), 'Job renamed');
  };
  const markComplete = () => {
    if (!jobId || !data) return;
    if (!window.confirm(`Mark job ${data.number} as complete?`)) return;
    const column = data.options.columns.find((c) => c.key === 'progress');
    void apply(() => customerJobsService.setStatus(jobId, 'progress', 'done'), `${column?.title ?? 'Active Clients'} set to Done`);
  };
  const toggleVoided = () => {
    if (!jobId || !data) return;
    if (data.voided) {
      void apply(() => customerJobsService.setVoided(jobId, false), 'Void reversed');
      return;
    }
    const reason = window.prompt(`Void job ${data.number}? Say why (optional) — this never deletes the job or anything on it.`);
    if (reason === null) return;
    void apply(() => customerJobsService.setVoided(jobId, true, reason.trim() || undefined), 'Job voided');
  };
  const remove = async () => {
    if (!jobId || !data) return;
    const sure = window.confirm(
      `Delete job ${data.number}? Its statuses, purchase orders and shipping are deleted with it. Its comments and files stay with the customer. This can’t be undone.`,
    );
    if (!sure) return;
    try {
      await customerJobsService.remove(jobId);
      toast.success(`Job ${data.number} deleted`);
      onClose();
      queryClient.removeQueries({ queryKey: ['customer-jobs', 'detail', jobId] });
      queryClient.removeQueries({ queryKey: ['customer-jobs', 'workspace', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['customer-jobs', 'list'], exact: false });
      void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    }
  };

  const attached = workspace.data;
  const proofs = attached?.files.filter((file) => file.kind === 'proof') ?? [];
  const count = (n: number | undefined) => (n ? ` (${n})` : '');
  const tabs = [
    { id: 'detail', label: 'Job detail' },
    { id: 'orders', label: `Purchase orders${count(data?.purchaseOrders.length)}` },
    { id: 'proofs', label: `Proofs${count(proofs.length)}` },
    { id: 'files', label: `Files${count(attached ? attached.files.length - proofs.length : 0)}` },
    { id: 'comments', label: `Comments${count(attached?.notes.length)}` },
    { id: 'tasks', label: `Tasks${count(attached?.tasks.length)}` },
    { id: 'shipping', label: `Shipping${count(data?.shipments.length)}` },
    { id: 'credits', label: `Credits${count(data?.credits.length)}` },
    { id: 'invoice', label: 'Invoice' },
    { id: 'activity', label: 'Activity' },
  ];

  const customerId = data?.customer.id;
  // The customer's panel opens with the name the job already carries.
  const onOpenCustomer = (id: string, quotationId?: string) =>
    openCustomerPanel(id, quotationId, data ? { name: data.customer.name, company: data.customer.company } : undefined);
  const [downloadingDoc, setDownloadingDoc] = useState<JobDocumentKind | null>(null);
  const downloadDocument = async (kind: JobDocumentKind, label: string) => {
    if (!jobId) return;
    setDownloadingDoc(kind);
    try {
      const blob = await customerJobsService.downloadDocument(jobId, kind);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${label.replace(/\s+/g, '-')}-${data?.number ?? jobId}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setDownloadingDoc(null);
    }
  };
  const pdfItem = (id: JobDocumentKind, label: string): DropdownItem => ({
    id,
    label: downloadingDoc === id ? `${label}…` : label,
    icon: <FiFileText />,
    onSelect: () => void downloadDocument(id, label),
  });
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const uploadReference = async (file: File | undefined) => {
    if (!jobId || !file) return;
    await apply(() => customerJobsService.setReferenceFile(jobId, file), `Reference “${file.name}” attached`);
  };
  const [sendingQuote, setSendingQuote] = useState(false);
  const sendJobQuote = async () => {
    if (!data) return;
    setSendingQuote(true);
    try {
      const result = await quotesService.send(data.quotationId);
      if (result.sent) toast.success(`Sent to ${result.to}`);
      else toast.error(`Email wasn’t sent — the server has no mail configured. Would have gone to ${result.to}.`, { duration: 8_000 });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSendingQuote(false);
    }
  };
  const [downloadingInvoicePdf, setDownloadingInvoicePdf] = useState(false);
  const downloadInvoicePdf = async () => {
    if (!data) return;
    setDownloadingInvoicePdf(true);
    try {
      // "Get Invoice PDF" — interpreted as a receipt-style statement of the
      // linked quotation's own payment history (quote-documents.service.ts's
      // getInvoicePdf), since this app has no separate Invoice document
      // issued against a job; see that service's own comment.
      await quotesService.downloadInvoicePdf(data.quotationId, data.quotationNumber);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setDownloadingInvoicePdf(false);
    }
  };
  const downloadReference = async () => {
    if (!jobId || !data?.referenceFileId) return;
    try {
      const blob = await customerJobsService.downloadReferenceFile(jobId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = data.referenceFileName ?? 'reference';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    }
  };
  const actions: DropdownItem[] = data
    ? [
        ...(customerId
          ? [{ id: 'customer', label: 'Open customer', icon: <FiUser />, onSelect: () => onOpenCustomer(customerId) }]
          : []),
        ...(data.contact.email
          ? [
              {
                id: 'send',
                label: sendingQuote ? 'Sending…' : 'Send',
                icon: <FiMail />,
                // "Send" — a job is always a converted quotation, so this
                // sends that same quote document (quotesService.send
                // already does a real email + attached PDF; see
                // quote-documents.service.ts's own comment on why that's
                // the one sales document this app actually has to send).
                onSelect: () => void sendJobQuote(),
              },
            ]
          : []),
        ...(data.contact.phone
          ? [
              {
                id: 'call',
                label: 'Call',
                icon: <FiPhone />,
                onSelect: () => window.open(`tel:${data.contact.phone!.replace(/[^+\d]/g, '')}`, '_self'),
              },
            ]
          : []),
        { id: 'rename', label: 'Edit (rename job)', icon: <FiEdit2 />, separatorBefore: true, onSelect: rename },
        pdfItem('job-sheet', 'PDF Job Sheet'),
        pdfItem('proof-sheet', 'PDF Proof Sheet'),
        pdfItem('packing-slip', 'PDF Packing Slip'),
        pdfItem('decorator-spec-sheet', 'PDF Decorator Spec Sheet'),
        pdfItem('shipping-label', 'Shipping Label'),
        {
          id: 'upload-proof',
          label: 'Upload Proof',
          icon: <FiPackage />,
          separatorBefore: true,
          onSelect: () => setTab('proofs'),
        },
        { id: 'add-po', label: 'Add Purchase Order', icon: <FiPlusSquare />, onSelect: () => setTab('orders') },
        { id: 'add-task', label: 'Add Task', icon: <FiPlusSquare />, onSelect: () => setTab('tasks') },
        {
          id: 'upload-reference',
          label: data.referenceFileId ? 'Replace Reference file' : 'Upload Reference file',
          icon: <FiFileText />,
          separatorBefore: true,
          onSelect: () => referenceInputRef.current?.click(),
        },
        ...(data.referenceFileId
          ? [
              {
                id: 'download-reference',
                label: `Download Reference (${data.referenceFileName ?? 'file'})`,
                icon: <FiFileText />,
                onSelect: () => void downloadReference(),
              },
            ]
          : []),
        {
          id: 'edit-invoice',
          label: 'Edit Invoice',
          icon: <FiFileText />,
          onSelect: () => setTab('invoice'),
        },
        {
          id: 'invoice-pdf',
          label: downloadingInvoicePdf ? 'Get Invoice PDF…' : 'Get Invoice PDF',
          icon: <FiFileText />,
          onSelect: () => void downloadInvoicePdf(),
        },
        {
          id: 'mark-complete',
          label: 'Mark as Complete',
          icon: <FiCheckCircle />,
          separatorBefore: true,
          onSelect: markComplete,
        },
        ...(data.canManage
          ? [
              {
                id: 'void',
                label: data.voided ? 'Reverse Void' : 'Void job',
                icon: <FiSlash />,
                danger: !data.voided,
                onSelect: toggleVoided,
              },
              { id: 'delete', label: 'Delete job', icon: <FiTrash2 />, danger: true, separatorBefore: true, onSelect: () => void remove() },
            ]
          : []),
      ]
    : [];

  const api = customerJobsService.workspaceApi(jobId ?? '');
  const headline = data
    ? jobHeadline(data)
    : preview?.who !== undefined
      ? { who: preview.who, facts: preview.facts ?? '' }
      : null;

  return (
    <Drawer
      open={!!jobId}
      onClose={onClose}
      title={
        data
          ? `Job ${data.number} · ${data.title}`
          : preview
            ? `Job ${preview.number}${preview.title ? ` · ${preview.title}` : ''}`
            : 'Job'
      }
      width={900}
      handover={handover}
      scrollKey={tab}
      description={
        headline ? (
          <>
            <span className={panelStyles.headCompany}>{headline.who}</span>
            <span>{headline.facts}</span>
          </>
        ) : isError ? undefined : (
          // Two lines held for what is on its way.
          <>
            <span className={panelStyles.ghostLine} aria-hidden>
              <Skeleton variant="text" width={180} />
            </span>
            <span className={panelStyles.ghostLine} aria-hidden>
              <Skeleton variant="text" width={260} />
            </span>
          </>
        )
      }
      actions={
        data ? (
          <Dropdown
            align="right"
            trigger={
              <Button type="button" variant="secondary" size="sm" rightIcon={<FiChevronDown />}>
                Actions
              </Button>
            }
            items={actions}
          />
        ) : isError ? undefined : (
          // Held in place while the panel loads, so the lines beside it wrap the same way before and after.
          <Button type="button" variant="secondary" size="sm" rightIcon={<FiChevronDown />} disabled>
            Actions
          </Button>
        )
      }
      // The tabs are there from the first moment: their counts fill in as the job loads.
      tabs={isError ? undefined : <Tabs items={tabs} activeId={tab} onChange={(next) => setTab(next as JobPanelTab)} />}
      header={
        isError ? undefined : !data ? (
          <>
            <div className={styles.statusRow} aria-hidden>
              {Array.from({ length: STATUSES }, (_, n) => (
                <div key={n} className={panelStyles.ghost}>
                  <Skeleton variant="text" width="55%" height={15} />
                  <Skeleton height={28} />
                </div>
              ))}
            </div>
            <div className={styles.dueRow} aria-hidden>
              <Skeleton width={230} height={32} />
            </div>
          </>
        ) : (
          <>
            {/* The same eight statuses as the board's columns — here each one is a menu. */}
            <div className={styles.statusRow} role="group" aria-label="Statuses">
              {data.statuses.map((chip, index) => {
                const column = data.options.columns.find((c) => c.key === chip.key);
                return column ? (
                  <JobStatusMenu
                    key={chip.key}
                    chip={chip}
                    column={column}
                    // Menus of the right-hand columns open leftwards, so none runs off the panel.
                    align={index >= 4 || index % 3 === 2 ? 'right' : 'left'}
                    busy={busy}
                    onSet={(status) => setStatus(chip, column, status)}
                  />
                ) : null;
              })}
            </div>
            <div className={styles.dueRow}>
              <label className={styles.dueField}>
                <span>Due date</span>
                <input
                  type="date"
                  className={panelStyles.field}
                  value={due}
                  disabled={busy}
                  onChange={(e) => changeDue(e.target.value)}
                />
              </label>
              {data.done ? (
                <Badge variant="success">Done</Badge>
              ) : data.overdue ? (
                <Badge variant="danger">Overdue</Badge>
              ) : null}
              <span className={styles.headHint}>
                Click a status to set it. Jobs are saved in HaiVE — your CRM is not changed.
              </span>
            </div>
            <div className={styles.dueRow}>
              <label className={styles.dueField}>
                <span>In Hands date</span>
                <input
                  type="date"
                  className={panelStyles.field}
                  value={inHands}
                  disabled={busy}
                  onChange={(e) => changeInHands(e.target.value)}
                />
              </label>
              <label className={styles.dueField}>
                <span>Production house</span>
                <select
                  className={panelStyles.field}
                  value={data.productionHouseVendorId ?? ''}
                  disabled={busy}
                  onChange={(e) => changeProductionHouse(e.target.value)}
                >
                  <option value="">Not set</option>
                  {vendorOptions.data?.map((v) => (
                    <option key={v._id} value={v._id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              {data.voided && (
                <Badge variant="danger">Voided{data.voidReason ? `: ${data.voidReason}` : ''}</Badge>
              )}
            </div>
          </>
        )
      }
    >
      {isLoading && (
        <div className={panelStyles.panel}>
          <Skeleton height={72} />
          <Skeleton height={220} />
        </div>
      )}
      {isError && (
        <EmptyState
          compact
          icon={FiAlertCircle}
          title="Couldn’t load this job"
          description={extractErrorMessage(error)}
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && jobId && (
        // Keyed by tab, so each one arrives with the same short fade.
        <div key={tab} className={panelStyles.panel}>
          {tab === 'detail' && (
            <JobDetailTab
              job={data}
              busy={busy}
              run={apply}
              onItemStatus={(index, status) =>
                void apply(() => customerJobsService.setItemStatus(jobId, index, status))
              }
              onOpenCustomer={onOpenCustomer}
            />
          )}
          {tab === 'orders' && <EntriesTab kind="orders" job={data} busy={busy} run={apply} />}
          {tab === 'proofs' && (
            <ProofsTab jobId={jobId} options={data.options.proofs} workspace={workspace} onChanged={changed} />
          )}
          {tab === 'files' && <FilesTab api={api} workspace={workspace} onChanged={changed} of="job" />}
          {tab === 'comments' && <CommentsTab api={api} workspace={workspace} onChanged={changed} of="job" />}
          {tab === 'tasks' && <TasksTab api={api} workspace={workspace} onChanged={changed} of="job" />}
          {tab === 'shipping' && <EntriesTab kind="shipping" job={data} busy={busy} run={apply} />}
          {tab === 'credits' && <EntriesTab kind="credits" job={data} busy={busy} run={apply} />}
          {tab === 'invoice' && <JobInvoiceTab jobId={jobId} />}
          {tab === 'activity' && <JobActivityTab job={data} />}
        </div>
      )}
      {/* Section 16's proof-of-remittance picker (triggered from setStatus
          above) and the Reference attachment's upload input — both hidden,
          always mounted while the panel has data so either can be opened
          from the status menu or the Actions dropdown without its own modal. */}
      <input
        ref={proofInputRef}
        type="file"
        hidden
        aria-label="Proof of payment/remittance"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void handleProofFile(file);
        }}
      />
      <input
        ref={referenceInputRef}
        type="file"
        hidden
        aria-label="Reference file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void uploadReference(file);
        }}
      />
    </Drawer>
  );
}

// One of the eight statuses at the top of the panel, as a menu: its column's options, and "Not set".
function JobStatusMenu({
  chip,
  column,
  align,
  busy,
  onSet,
}: {
  chip: JobStatusChip;
  column: JobStatusColumn;
  align: 'left' | 'right';
  busy: boolean;
  // One of the column's options, or null for "Not set".
  onSet: (status: string | null) => void;
}) {
  const items: DropdownItem[] = column.options.map((option) => ({
    id: option.status,
    // The one in force carries a tick.
    label: chip.status === option.status ? `${option.label}  ✓` : option.label,
    icon: <span className={clsx(panelStyles.optionDot, panelStyles[`tone_${option.tone}`])} aria-hidden />,
    onSelect: () => onSet(option.status),
  }));
  if (chip.status)
    items.push({ id: 'unset', label: 'Not set', icon: <FiX />, separatorBefore: true, onSelect: () => onSet(null) });
  return (
    <Dropdown
      className={panelStyles.stageMenu}
      align={align}
      items={items}
      trigger={
        <button
          type="button"
          className={panelStyles.stageButton}
          aria-haspopup="menu"
          aria-label={`${chip.title}: ${chip.full}. Change the ${chip.title.toLowerCase()} status`}
          disabled={busy}
        >
          <StageChip stage={chip} showTitle showDetail={false} menu />
        </button>
      }
    />
  );
}
