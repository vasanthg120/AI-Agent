import { useEffect, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FiAlertCircle,
  FiChevronDown,
  FiCopy,
  FiCpu,
  FiMail,
  FiMessageSquare,
  FiPaperclip,
  FiPhone,
} from 'react-icons/fi';
import { Button, Drawer, Dropdown, EmptyState, Input, Modal, Skeleton, Tabs } from '@/components/ui';
import type { DropdownItem } from '@/components/ui';
import { customersService, type CustomerDetail, type Stage, type StageKey } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import { ActivityTab } from './panel/ActivityTab';
import { DetailsTab } from './panel/DetailsTab';
import { DocumentsTab } from './panel/DocumentsTab';
import { MailTab } from './panel/MailTab';
import { StageMenu } from './panel/StageMenu';
import { customerCloudService } from '@/services/customerCloudService';
import { CustomerDocuments } from './panel/CustomerDocuments';
import { CommentsTab } from './panel/WorkspaceTabs';
import styles from './panel/panel.module.css';

export type PanelTab = 'details' | 'documents' | 'mail' | 'activity' | 'comments' | 'files';

// What whoever opens the panel already knows about the customer: shown at once, until the rest has loaded.
export interface CustomerPreview {
  name: string;
  company?: string;
  owner?: string;
  sources?: string[];
}

// The six steps and the tabs keep their place while the customer loads, so nothing jumps when they arrive.
const STEPS = 6;

// One customer in full, in a panel beside the board: what to do next and who
// they are; every quotation and invoice with what it is connected to; the
// emails and follow-ups; everything that happened; and what the team itself
// has written, set itself to do and attached. Everything is one click from
// everything else — a step of the journey opens its document, a document names
// the steps before and after it.
export function CustomerPanel({
  customerId,
  preview,
  initialTab,
  initialDocumentId,
  handover,
  onClose,
  onOpenJob,
}: {
  customerId: string | null;
  preview?: CustomerPreview;
  // This panel is taking over from the job panel, or handing over to it: it changes in place.
  handover?: boolean;
  // Where to land — "Add comment" on a row opens the panel on Comments.
  initialTab?: PanelTab;
  // A quotation or invoice to land on, opened in full (a job leads back to its quotation).
  initialDocumentId?: string;
  onClose: () => void;
  // A job of this customer was asked for: the page shows it.
  onOpenJob?: (jobId: string, number?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<PanelTab>('details');
  // The quotation or invoice being read in full, inside "Quotes & orders".
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // "Pick another date…" on the Follow-up status.
  const [pickingDate, setPickingDate] = useState(false);
  // The status being saved: its menu waits until the board has caught up.
  const [savingStage, setSavingStage] = useState<StageKey | null>(null);
  const detailKey = ['customers', 'detail', customerId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: detailKey,
    queryFn: () => customersService.get(customerId!),
    enabled: !!customerId,
  });
  // Comments, tasks and files: their counts sit on the tabs, so they load with the panel.
  const workspace = useQuery({
    queryKey: ['customers', 'workspace', customerId],
    queryFn: () => customersService.workspace(customerId!),
    enabled: !!customerId,
  });
  // Their Google Drive / OneDrive folders and attached files: counted on the same tab as HaiVE's files.
  const cloudDocs = useQuery({
    queryKey: ['customer-cloud', customerId],
    queryFn: () => customerCloudService.overview(customerId!),
    enabled: !!customerId,
  });

  useEffect(() => {
    setTab(initialDocumentId ? 'documents' : (initialTab ?? 'details'));
    setDocumentId(initialDocumentId ?? null);
  }, [customerId, initialTab, initialDocumentId]);

  const analyze = async (refresh: boolean) => {
    if (!customerId) return;
    setTab('details');
    setAnalyzing(true);
    try {
      const analysis = await customersService.analyze(customerId, refresh);
      queryClient.setQueryData<CustomerDetail>(detailKey, (prev) => (prev ? { ...prev, analysis } : prev));
      // The board shows the AI summary in place of the worked-out one.
      void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setAnalyzing(false);
    }
  };

  // What the team changes here shows on the board (a task is a follow-up) and in the timeline.
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
  };
  const openDocument = (id: string) => {
    setDocumentId(id);
    setTab('documents');
  };
  const goTo = (next: string) => {
    setTab(next as PanelTab);
    setDocumentId(null);
  };

  const counts = workspace.data;
  const openTasks = counts?.tasks.filter((t) => t.status === 'open').length ?? 0;
  const api = customersService.workspaceApi(customerId ?? '');

  // ---- the six statuses, set by hand from the top of the panel. Saved in HaiVE only: no CRM is changed.
  const act = async (stage: StageKey, run: () => Promise<unknown>, done: string) => {
    setSavingStage(stage);
    try {
      await run();
      toast.success(done);
      // The board, its tiles and "Next step" all read the status.
      await queryClient.invalidateQueries({ queryKey: ['customers'], exact: false, refetchType: 'active' });
    } catch (err) {
      toast.error(extractErrorMessage(err), { duration: 8_000 });
    } finally {
      setSavingStage(null);
    }
  };
  const setStatus = (stage: Stage, status: string | null) => {
    if (!customerId || !data) return;
    // Choosing what is already in force changes nothing.
    if (status === null ? !stage.manual : stage.manual && stage.status === status) return;
    const label = data.statusOptions[stage.key].find((o) => o.status === status)?.label;
    void act(
      stage.key,
      () => customersService.setStatus(customerId, stage.key, status),
      label ? `${stage.title} set to ${label}` : `${stage.title} follows your connected systems again`,
    );
  };
  const scheduleFollowUp = (daysFromToday: number) => scheduleFollowUpOn(dayjs().add(daysFromToday, 'day'));
  const scheduleFollowUpOn = (day: Dayjs) => {
    if (!customerId) return;
    void act(
      'followUp',
      // The middle of that day, so it is that day wherever it is read.
      () =>
        customersService.addTask(customerId, {
          title: 'Follow up',
          dueDate: day.hour(12).minute(0).second(0).toISOString(),
        }),
      day.isSame(dayjs(), 'day') ? 'Follow-up set for today' : `Follow-up set for ${day.format('ddd D MMM')}`,
    );
  };
  const finishFollowUps = () => {
    const open = counts?.tasks.filter((t) => t.status === 'open') ?? [];
    if (!customerId || open.length === 0) return;
    void act(
      'followUp',
      async () => {
        for (const task of open) await customersService.updateTask(customerId, task.id, { status: 'done' });
      },
      open.length === 1 ? 'Follow-up marked done' : `${open.length} follow-ups marked done`,
    );
  };
  const count = (n: number | undefined) => (n ? ` (${n})` : '');
  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'documents', label: `Quotes & orders${count(data?.documents.length)}` },
    { id: 'mail', label: `Emails${count(data?.emails.length)}` },
    { id: 'activity', label: 'Activity' },
    { id: 'comments', label: `Comments${count(counts?.notes.length)}` },
    { id: 'files', label: `Files & documents${count((counts?.files.length ?? 0) + (cloudDocs.data?.links.length ?? 0) + (cloudDocs.data?.folders.length ?? 0))}` },
  ];

  const actions: DropdownItem[] = data
    ? [
        ...(data.email
          ? [
              {
                id: 'email',
                label: 'Email',
                icon: <FiMail />,
                onSelect: () => window.open(`mailto:${data.email}`, '_self'),
              },
            ]
          : []),
        ...(data.phone
          ? [
              {
                id: 'call',
                label: 'Call',
                icon: <FiPhone />,
                onSelect: () => window.open(`tel:${data.phone!.replace(/[^+\d]/g, '')}`, '_self'),
              },
            ]
          : []),
        {
          id: 'copy',
          label: 'Copy contact',
          icon: <FiCopy />,
          onSelect: () =>
            void navigator.clipboard
              .writeText([data.name, data.company, data.email, data.phone].filter(Boolean).join('\n'))
              .then(() => toast.success('Contact copied')),
        },
        {
          id: 'analyze',
          label: data.analysis ? 'Analyze again with AI' : 'Analyze with AI',
          icon: <FiCpu />,
          separatorBefore: true,
          onSelect: () => void analyze(!!data.analysis),
        },
        {
          id: 'comment',
          label: 'Add comment',
          icon: <FiMessageSquare />,
          separatorBefore: true,
          onSelect: () => goTo('comments'),
        },
        { id: 'file', label: 'Upload file', icon: <FiPaperclip />, onSelect: () => goTo('files') },
      ]
    : [];

  return (
    <Drawer
      open={!!customerId}
      onClose={onClose}
      title={data?.name ?? preview?.name ?? 'Customer'}
      width={900}
      handover={handover}
      scrollKey={`${tab}:${documentId ?? ''}`}
      description={
        data ? (
          <>
            {data.company && <span className={styles.headCompany}>{data.company}</span>}
            <span>
              {[data.owner ? `Owner: ${data.owner}` : '', data.sources.join(' + ')].filter(Boolean).join(' · ')}
            </span>
          </>
        ) : isError ? undefined : (
          // What whoever opened the panel already knew — the same two lines, so nothing moves when the rest arrives.
          <>
            {preview?.company && <span className={styles.headCompany}>{preview.company}</span>}
            {preview?.sources ? (
              <span>
                {[preview.owner ? `Owner: ${preview.owner}` : '', preview.sources.join(' + ')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : (
              <span className={styles.ghostLine} aria-hidden>
                <Skeleton variant="text" width={220} />
              </span>
            )}
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
      // The tabs are there from the first moment: their counts fill in as the customer loads.
      tabs={isError ? undefined : <Tabs items={tabs} activeId={tab} onChange={goTo} />}
      header={
        isError ? undefined : !data ? (
          <>
            <div className={styles.stageRow} aria-hidden>
              {Array.from({ length: STEPS }, (_, n) => (
                <div key={n} className={styles.ghost}>
                  <Skeleton variant="text" width="55%" height={15} />
                  <Skeleton height={28} />
                </div>
              ))}
            </div>
            <p className={styles.stageHint}>
              Click a status to change it. What you set is saved in HaiVE and marked with a pencil — your CRM is not
              changed.
            </p>
          </>
        ) : (
          <>
            {/* The same six steps as the board's columns — here each one is a menu: click it to set it by hand. */}
            <div className={styles.stageRow} role="group" aria-label="Statuses">
              {data.stages.map((step, index) => (
                <StageMenu
                  key={step.key}
                  stage={step}
                  options={data.statusOptions[step.key]}
                  // Menus of the right-hand columns open leftwards, so none runs off the panel.
                  align={index % 3 === 2 || index >= 4 ? 'right' : 'left'}
                  busy={savingStage !== null}
                  onSet={(status) => setStatus(step, status)}
                  followUp={
                    step.key === 'followUp'
                      ? {
                          openTasks,
                          reminders: data.followUps.filter((f) => f.status === 'pending').length,
                          onSchedule: scheduleFollowUp,
                          onPickDate: () => setPickingDate(true),
                          onDone: finishFollowUps,
                          onShowReminders: () => goTo('mail'),
                        }
                      : undefined
                  }
                />
              ))}
            </div>
            <p className={styles.stageHint}>
              Click a status to change it. What you set is saved in HaiVE and marked with a pencil — your CRM is not
              changed.
            </p>
          </>
        )
      }
    >
      {isLoading && (
        <div className={styles.panel}>
          <Skeleton height={72} />
          <Skeleton height={220} />
        </div>
      )}
      {isError && (
        <EmptyState
          compact
          icon={FiAlertCircle}
          title="Couldn’t load this customer"
          description={extractErrorMessage(error)}
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && customerId && (
        // Keyed by tab, so each one arrives with the same short fade.
        <div key={tab} className={styles.panel}>
          {tab === 'details' && (
            <DetailsTab
              detail={data}
              analyzing={analyzing}
              onAnalyze={(refresh) => void analyze(refresh)}
              onOpenDocument={openDocument}
              onOpenJob={onOpenJob}
            />
          )}
          {tab === 'documents' && (
            <DocumentsTab
              detail={data}
              documentId={documentId}
              onOpen={setDocumentId}
              onGoTo={goTo}
              onOpenJob={onOpenJob}
            />
          )}
          {tab === 'mail' && <MailTab detail={data} />}
          {tab === 'activity' && <ActivityTab detail={data} />}
          {tab === 'comments' && (
            <CommentsTab api={api} workspace={workspace} onChanged={changed} onOpenJob={onOpenJob} />
          )}
          {tab === 'files' && (
            <CustomerDocuments
              customerId={customerId}
              folderName={data.company ?? data.name}
              quotations={data.documents
                .filter((d) => d.kind === 'quotation')
                .map((d) => ({ id: d.id, label: d.number ? `Quotation ${d.number}` : (d.title ?? 'Quotation') }))}
              api={api}
              workspace={workspace}
              onChanged={changed}
              onOpenJob={onOpenJob}
            />
          )}
        </div>
      )}
      <FollowUpDateDialog open={pickingDate} onClose={() => setPickingDate(false)} onPick={scheduleFollowUpOn} />
    </Drawer>
  );
}

/** A follow-up on a day of one's choosing (the Follow-up status's "Pick another date…"). */
function FollowUpDateDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (day: Dayjs) => void }) {
  const tomorrow = () => dayjs().add(1, 'day').format('YYYY-MM-DD');
  const [value, setValue] = useState(tomorrow);
  useEffect(() => {
    if (open) setValue(tomorrow());
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Follow up on…" description="The day to follow up with this customer. It shows on the board until it is marked done.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value) return;
          onPick(dayjs(value));
          onClose();
        }}
      >
        <Input type="date" label="Follow-up date" value={value} min={dayjs().format('YYYY-MM-DD')} onChange={(e) => setValue(e.target.value)} />
        <div className={styles.dialogActions}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value}>
            Set follow-up
          </Button>
        </div>
      </form>
    </Modal>
  );
}
