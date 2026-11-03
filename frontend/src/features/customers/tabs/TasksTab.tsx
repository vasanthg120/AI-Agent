import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FiCheckSquare, FiSquare } from 'react-icons/fi';
import clsx from 'clsx';
import { Badge, PageHeader } from '@/components/ui';
import { DataTable, TableToolbar } from '@/components/board';
import type { DataTableColumn } from '@/components/board';
import { customersService, type CrossCustomerTask } from '@/services/customersService';
import { extractErrorMessage } from '@/utils/errors';
import customerStyles from '../customers.module.css';
import styles from './tabs.module.css';

// Hoops-parity — the Tasks tab, in-page inside /customers. Reuses the
// existing per-customer/per-job CustomerTask collection across every
// record the caller can see (customersService.listAllTasks ->
// CustomerWorkspaceService.listAllTasks, backed by the same
// TASKS_COLLECTION every other task call already uses) — no new task
// system alongside the AI daily To-Do/EOD board.
export const TasksTab = memo(function TasksTab({
  tabs,
  offstage,
  onOpenCustomer,
}: {
  tabs: ReactNode;
  offstage: boolean;
  onOpenCustomer: (customerId: string) => void;
}) {
  const [status, setStatus] = useState<'' | 'open' | 'done'>('open');
  const [mineOnly, setMineOnly] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['customers', 'tasks', status, mineOnly],
    queryFn: () => customersService.listAllTasks({ status: status || undefined, mine: mineOnly || undefined }),
    enabled: !offstage,
  });

  const toggle = useMutation({
    mutationFn: (task: CrossCustomerTask) =>
      customersService.updateTask(task.customerId, task.id, { status: task.status === 'done' ? 'open' : 'done' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['customers', 'tasks'] }),
    onError: (err) => toast.error(extractErrorMessage(err), { duration: 8_000 }),
  });

  const columns: DataTableColumn<CrossCustomerTask>[] = [
    {
      key: 'title',
      header: 'Task',
      alwaysVisible: true,
      render: (t) => (
        <button
          type="button"
          className={styles.taskToggle}
          aria-label={t.status === 'done' ? `Mark ${t.title} as not done` : `Mark ${t.title} as done`}
          onClick={(e) => {
            e.stopPropagation();
            toggle.mutate(t);
          }}
        >
          {t.status === 'done' ? <FiCheckSquare aria-hidden /> : <FiSquare aria-hidden />}
          <span className={clsx(t.status === 'done' && styles.taskDone)}>{t.title}</span>
        </button>
      ),
    },
    { key: 'customer', header: 'Customer', render: (t) => t.customerName },
    { key: 'assignee', header: 'Assignee', render: (t) => t.assignee ?? '—' },
    {
      key: 'due',
      header: 'Due',
      render: (t) =>
        t.dueDate ? (
          <Badge variant={t.overdue ? 'danger' : 'neutral'}>{new Date(t.dueDate).toLocaleDateString()}</Badge>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div className={customerStyles.page} hidden={offstage}>
      {tabs}
      <PageHeader icon={FiCheckSquare} title="Tasks" subtitle="Every task across every customer and job." />

      <TableToolbar
        filters={
          <>
            <select
              aria-label="Status"
              className={styles.inlineSelect}
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | 'open' | 'done')}
            >
              <option value="">Any status</option>
              <option value="open">Open</option>
              <option value="done">Done</option>
            </select>
            <button
              type="button"
              className={clsx(styles.inlineSelect, mineOnly && styles.inlineSelectActive)}
              aria-pressed={mineOnly}
              onClick={() => setMineOnly((v) => !v)}
            >
              My tasks only
            </button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(t) => t.id}
        loading={isLoading}
        busy={isFetching}
        onRowClick={(t) => onOpenCustomer(t.customerId)}
        emptyState={<p className={customerStyles.none}>No tasks match this view.</p>}
      />
    </div>
  );
});
