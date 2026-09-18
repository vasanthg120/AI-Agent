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

export interface TaskRecommendation {
  taskId: string;
  rationale: string;
  task: TodoTask;
}

export interface TaskRecommendations {
  recommendations: TaskRecommendation[];
  overallNote: string;
}

export const todoEodService = {
  async getTasks(params: ListTasksParams = {}): Promise<TodoTask[]> {
    const { data } = await axiosClient.get<{ tasks: TodoTask[] }>('/tasks', { params });
    return data.tasks;
  },

  async getCalendar(month: string): Promise<{ month: string; days: CalendarDaySummary[] }> {
    const { data } = await axiosClient.get<{ month: string; days: CalendarDaySummary[] }>('/tasks/calendar', {
      params: { month },
    });
    return data;
  },

  async updateTaskStatus(id: string, status: TaskStatus): Promise<{ id: string; status: TaskStatus }> {
    const { data } = await axiosClient.patch<{ id: string; status: TaskStatus }>(`/tasks/${id}`, { status });
    return data;
  },

  async getRecommendations(): Promise<TaskRecommendations> {
    const { data } = await axiosClient.get<TaskRecommendations>('/tasks/recommendations');
    return data;
  },

  async downloadExport(format: 'pdf' | 'csv', params: ListTasksParams = {}): Promise<void> {
    const response = await axiosClient.get('/tasks/export', {
      params: { ...params, format },
      responseType: 'blob',
    });
    const disposition = response.headers['content-disposition'] as string | undefined;
    const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `tasks.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
