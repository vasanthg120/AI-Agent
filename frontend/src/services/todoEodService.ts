import { axiosClient } from '@/api/axiosClient';

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface TodoTask {
  id: string;
  title: string;
  priority: TaskPriority;
  category?: string;
  isOverdue: boolean;
  status: TaskStatus;
  agentId: string;
  reportId: string;
  reportType: 'morning' | 'eod';
  date: string;
  // Additive — set only when the backend could resolve a task to a real
  // owner (see dashboard.service.ts's attributeTask). Undefined means
  // shared/unassigned, exactly like every task before this existed.
  assignedUserId?: string;
}

export interface CalendarDaySummary {
  date: string;
  reportCount: number;
  taskCount: number;
  hasUrgent: boolean;
}

export interface ListTasksParams {
  status?: TaskStatus;
  dateFrom?: string;
  dateTo?: string;
  // Additive — omitted (the default) returns the same shared board as
  // always. true narrows to tasks assigned to the caller plus any
  // still-unassigned/shared task.
  mine?: boolean;
}

export interface EodSummary {
  date: string;
  tasksCompleted: TodoTask[];
  tasksPending: TodoTask[];
  email: { received: number; sent: number; responded: number; pending: number };
  crm: { dealsCreated: number; dealsUpdated: number; quotesCreated: number; quotesUpdated: number };
  // Store-wide, never per-user — Contact/Account have no owner field to
  // scope by (see tasks.service.ts's getEodSummary for why), so this is
  // never presented as "your" new contacts/accounts.
  newContactsAcrossOrg: number;
  newAccountsAcrossOrg: number;
  narrativeSummary: string | null;
  reportExists: boolean;
  reportGeneratedAt: string | null;
}

export const todoEodService = {
  async getTasks(params: ListTasksParams = {}): Promise<TodoTask[]> {
    const { data } = await axiosClient.get<{ tasks: TodoTask[] }>('/tasks', { params });
    return data.tasks;
  },

  // reportType is optional — omitted (the To-Do board's own calendar) counts
  // both morning+eod reports exactly as before; the EOD page's calendar
  // passes 'eod' so a day with only a morning report doesn't show as having
  // an EOD one.
  async getCalendar(month: string, reportType?: 'morning' | 'eod'): Promise<{ month: string; days: CalendarDaySummary[] }> {
    const { data } = await axiosClient.get<{ month: string; days: CalendarDaySummary[] }>('/tasks/calendar', {
      params: { month, reportType },
    });
    return data;
  },

  async updateTaskStatus(id: string, status: TaskStatus): Promise<{ id: string; status: TaskStatus }> {
    const { data } = await axiosClient.patch<{ id: string; status: TaskStatus }>(`/tasks/${id}`, { status });
    return data;
  },

  // date is optional (defaults to today on the backend) — the EOD page's
  // Calendar view passes an explicit past date to look up that day's report.
  async getEodSummary(date?: string): Promise<EodSummary> {
    const { data } = await axiosClient.get<EodSummary>('/tasks/eod', { params: { date } });
    return data;
  },

  async downloadExport(format: 'pdf' | 'csv', params: ListTasksParams = {}): Promise<void> {
    const response = await axiosClient.get('/tasks/export', {
      params: { ...params, format },
      responseType: 'blob',
    });
    downloadBlobResponse(response, `tasks.${format}`);
  },

  // A real EOD report export (narrative/email/CRM breakdown), not a re-
  // export of that day's task list — see backend/src/dashboard/tasks.controller.ts's
  // own comment on the new GET /tasks/eod/export route this calls.
  async downloadEodExport(format: 'pdf' | 'csv', date: string): Promise<void> {
    const response = await axiosClient.get('/tasks/eod/export', {
      params: { date, format },
      responseType: 'blob',
    });
    downloadBlobResponse(response, `eod-${date}.${format}`);
  },
};

function downloadBlobResponse(response: { headers: Record<string, unknown>; data: unknown }, fallbackFilename: string): void {
  const disposition = response.headers['content-disposition'] as string | undefined;
  const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
  const url = URL.createObjectURL(response.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? fallbackFilename;
  a.click();
  URL.revokeObjectURL(url);
}
