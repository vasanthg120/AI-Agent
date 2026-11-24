import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckSquare, FiRefreshCw } from 'react-icons/fi';
import { Badge, Button, EmptyState, Modal, PageHeader, Skeleton, StatTile, Tabs } from '@/components/ui';
import { extractErrorMessage } from '@/utils/errors';
import { workAutomationService } from '@/services/workAutomationService';
import type { WorkTask } from '@/services/workAutomationService';
import { useAuthStore } from '@/stores/authStore';
import { EodReportView } from './EodReportView';
import { WorkTaskRow } from './WorkTaskRow';
import styles from './Work.module.css';

const TABS = [
  { id: 'todo', label: 'My To-Do' },
  { id: 'completed', label: 'Completed' },
  { id: 'activity', label: "Today's activity" },
  { id: 'eod', label: 'EOD reports' },
];

const ACTIVITY_LABEL: Record<string, string> = {
  created: 'Collected',
  updated: 'Updated',
  status_changed: 'Status changed',
  completed: 'Completed',
  reassigned: 'Reassigned',
  deactivated: 'Removed from your list',
  reactivated: 'Back on your list',
  verification_requested: 'Verification requested',
};

function TaskGroup({ title, tasks, onChanged, userId }: { title: string; tasks: WorkTask[]; onChanged: () => void; userId: string }) {
  if (tasks.length === 0) return null;
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>
        {title} <Badge>{tasks.length}</Badge>
      </h3>
      <div className={styles.list}>
        {tasks.map((t) => (
          <WorkTaskRow key={t.id} task={t} isAssignee={t.assignedTo === userId} canVerify={false} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

/**
 * The employee's own automatic To-Do: everything assigned to them across the connected
 * platforms, collected without anyone typing it in. Opening the page refreshes it
 * (the server skips the refresh if one just ran).
 */
export function MyWorkPage() {
  const userId = useAuthStore((s) => s.user?.id ?? '');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('todo');
  const [openReport, setOpenReport] = useState<string | null>(null);

  const day = useQuery({ queryKey: ['work-day'], queryFn: () => workAutomationService.myDay() });
  const activity = useQuery({ queryKey: ['work-activity'], queryFn: () => workAutomationService.myActivity(), enabled: tab === 'activity' });
  const reports = useQuery({ queryKey: ['work-eod-mine'], queryFn: () => workAutomationService.myReports(), enabled: tab === 'eod' });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['work-day'] });
    void queryClient.invalidateQueries({ queryKey: ['work-activity'] });
  };

  // Refresh from the source platforms when the person opens their list (no-op server-side if synced recently).
  useEffect(() => {
    workAutomationService
      .syncMe()
      .then(() => refresh())
      .catch(() => undefined); // the page still shows what was collected earlier
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    setSyncing(true);
    try {
      await workAutomationService.syncMeNow();
      refresh();
      toast.success('Your work was refreshed from the connected platforms.');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const d = day.data;

  return (
    <div className={styles.page}>
      <PageHeader
        icon={FiCheckSquare}
        title="My Work"
        subtitle="Everything assigned to you across your connected platforms, collected automatically. Your end-of-day report is generated and emailed for you."
        actions={
          <Button type="button" variant="outline" leftIcon={<FiRefreshCw />} loading={syncing} onClick={() => void syncNow()}>
            Refresh
          </Button>
        }
      />

      <div className={styles.tiles}>
        <StatTile label="Open" value={d?.counts.open ?? 0} />
        <StatTile label="Overdue" value={d?.counts.overdue ?? 0} />
        <StatTile label="Completed today" value={d?.counts.completed ?? 0} />
        <StatTile label="Blocked" value={d?.counts.blocked ?? 0} />
        <StatTile label="Awaiting verification" value={d?.counts.awaitingVerification ?? 0} />
      </div>

      <Tabs items={TABS} activeId={tab} onChange={setTab} />

      {tab === 'todo' &&
        (day.isLoading ? (
          <Skeleton height={120} />
        ) : !d || d.counts.open === 0 ? (
          <EmptyState
            icon={FiCheckSquare}
            title="Nothing assigned to you right now"
            description="Work from Pantheras, Hoops and your email appears here on its own. Refresh to check the platforms again."
          />
        ) : (
          <>
            <TaskGroup title="Overdue" tasks={d.overdue} onChanged={refresh} userId={userId} />
            <TaskGroup title="To do" tasks={d.open} onChanged={refresh} userId={userId} />
          </>
        ))}

      {tab === 'completed' &&
        (d && d.completed.length > 0 ? (
          <TaskGroup title={`Completed on ${d.date}`} tasks={d.completed} onChanged={refresh} userId={userId} />
        ) : (
          <EmptyState compact icon={FiCheckSquare} title="Nothing completed yet today" description="Work shows here once its source confirms it, or a manager verifies it." />
        ))}

      {tab === 'activity' &&
        ((activity.data ?? []).length === 0 ? (
          <EmptyState compact title="No activity recorded yet today" />
        ) : (
          <div className={styles.list}>
            {(activity.data ?? []).map((a, i) => (
              <div key={i} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.title}>{a.taskTitle ?? 'Task'}</span>
                  <div className={styles.meta}>
                    <Badge>{ACTIVITY_LABEL[a.type] ?? a.type}</Badge>
                    <span>{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {a.note && <span>{a.note}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === 'eod' &&
        ((reports.data ?? []).length === 0 ? (
          <EmptyState compact title="No EOD reports yet" description="Your report is generated automatically at the end of your business day." />
        ) : (
          <div className={styles.list}>
            {(reports.data ?? []).map((r) => (
              <div key={r.id} className={`${styles.row} ${styles.clickable}`} role="button" tabIndex={0} onClick={() => setOpenReport(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenReport(r.id)}>
                <div className={styles.rowMain}>
                  <span className={styles.title}>{r.date}</span>
                  <div className={styles.meta}>
                    <Badge variant={r.status === 'generated' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Badge>
                    {r.counts && (
                      <span>
                        {r.counts.completed} completed · {r.counts.pending} pending · {r.counts.overdue} overdue
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}

      <Modal open={!!openReport} onClose={() => setOpenReport(null)} title="End-of-day report" maxWidth={760}>
        {openReport && <EodReportView reportId={openReport} />}
      </Modal>
    </div>
  );
}
