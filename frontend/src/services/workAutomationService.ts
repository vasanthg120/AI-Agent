import { axiosClient } from '@/api/axiosClient';

export type WorkTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'awaiting_verification';
export type WorkEffectiveStatus = WorkTaskStatus | 'overdue';
export type WorkPriority = 'urgent' | 'high' | 'medium' | 'low';
export type WorkAction = 'start' | 'block' | 'unblock' | 'request_verification' | 'reject_verification' | 'verify' | 'reopen';

export interface WorkEvidence {
  type: 'source_status' | 'source_event' | 'manual_verified';
  detail: string;
  at: string;
  verifiedBy?: string;
}

export interface WorkTask {
  id: string;
  assignedTo: string;
  title: string;
  description?: string;
  priority: WorkPriority;
  dueDate?: string;
  status: WorkTaskStatus;
  effectiveStatus: WorkEffectiveStatus;
  sourcePlatform: string;
  sourceType: string;
  sourceRecordId: string;
  sourceUrl?: string;
  sourceStatus?: string;
  lastSyncedAt?: string;
  completedAt?: string;
  completionEvidence?: WorkEvidence;
}

export interface WorkDay {
  userId: string;
  date: string;
  timezone: string;
  open: WorkTask[];
  overdue: WorkTask[];
  completed: WorkTask[];
  counts: { open: number; overdue: number; completed: number; blocked: number; awaitingVerification: number };
}

export interface WorkActivity {
  at: string;
  type: string;
  actor: string;
  taskId: string;
  taskTitle?: string;
  note?: string;
}

export interface TaskSnapshot {
  taskId: string;
  title: string;
  priority: string;
  status: string;
  dueDate?: string;
  sourcePlatform: string;
  sourceType: string;
  sourceUrl?: string;
  evidence?: WorkEvidence;
}

export type EodHeadline = 'worked' | 'no_completed_work' | 'no_assigned_work' | 'sync_unreliable';

export interface EodAssessment {
  headline: EodHeadline;
  assignedWork: boolean;
  completedWork: boolean;
  activityDetected: boolean;
  activitySignals: 'complete' | 'partial';
  syncHealth: 'ok' | 'degraded' | 'unknown';
  syncNotes: string[];
}

export interface EodSections {
  assessment?: EodAssessment;
  completed: TaskSnapshot[];
  pending: TaskSnapshot[];
  overdue: TaskSnapshot[];
  blocked: TaskSnapshot[];
  awaitingVerification: TaskSnapshot[];
  meetings: { source: string; items: { title: string; start: string; end: string; organizer?: string }[] };
  customerFollowUps: { repliesSent: number; completed: TaskSnapshot[]; pending: TaskSnapshot[] };
  crmUpdates: { kind: string; entity: string; customerName?: string; value?: number; currency?: string; at: string }[];
  nextDayPriorities: TaskSnapshot[];
  counts: { completed: number; pending: number; overdue: number; blocked: number; awaitingVerification: number };
}

export interface EodListItem {
  id: string;
  userId: string;
  employeeName?: string;
  date: string;
  timezone: string;
  status: 'generating' | 'generated' | 'failed';
  generatedAt?: string;
  wasMissed: boolean;
  summarySource?: 'ai' | 'deterministic';
  counts?: EodSections['counts'];
}

export interface EodReportDetail extends EodListItem {
  sections?: EodSections;
  summary?: string;
  dataGaps: string[];
}

export interface EodDeliveryRow {
  role: 'employee' | 'manager';
  recipientEmail?: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  channel?: string;
  attempts: number;
  sentAt?: string;
  lastError?: string;
  skippedReason?: string;
  nextAttemptAt?: string;
}

export type ReportState = 'generated' | 'failed' | 'generating' | 'missing' | 'not_due' | 'no_work';

export interface TeamRow {
  userId: string;
  name: string;
  email: string;
  counts: { open: number; overdue: number; completedToday: number; blocked: number; awaitingVerification: number };
  report: { state: ReportState; reportId?: string; generatedAt?: string; deliveries: { employee?: string; manager?: string } };
}

export interface TeamDashboard {
  date: string;
  timezone: string;
  eodTime: string;
  admin: boolean;
  totals: { people: number; open: number; overdue: number; completedToday: number; reportsGenerated: number; reportsMissing: number };
  rows: TeamRow[];
}

export interface AutomationConfig {
  enabled: boolean;
  eodTime: string;
  timezone: string;
  enabledSources: string[];
  crmProviders: string[];
  staleDealDays: number;
  dealCloseWindowDays: number;
  quoteDueWindowDays: number;
  emailLookbackDays: number;
  syncOnLoginMinIntervalMin: number;
  sendToManager: boolean;
  deliveryChannels: ('gmail' | 'outlook' | 'smtp')[];
  maxDeliveryAttempts: number;
}

export interface ConfigResponse {
  config: AutomationConfig;
  effectiveTimezone: string;
  sources?: { id: string; label: string; description: string; enabled: boolean }[];
  unsupported?: { id: string; label: string; reason: string }[];
}

export interface SyncRun {
  adapterId: string;
  trigger: string;
  status: 'ok' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string;
  userId?: string;
  fetched: number;
  created: number;
  updated: number;
  completed: number;
  deactivated: number;
  unresolved: number;
  error?: string;
}

export interface SyncStatus {
  adapters: { id: string; label: string; enabled: boolean; last: SyncRun | null }[];
  unresolvedIdentities: number;
  recent: SyncRun[];
}

export interface IdentityRow {
  id: string;
  platform: string;
  externalUserId: string;
  externalEmail?: string;
  externalName?: string;
  status: 'linked' | 'unresolved' | 'ignored';
  userId?: string;
  userName?: string;
  matchMethod?: string;
  seenCount: number;
  lastSeenAt?: string;
}

export interface HierarchyPerson {
  id: string;
  name: string;
  email: string;
  active: boolean;
  reportingManagerId?: string;
}

const BASE = '/work-automation';
const ADMIN = '/work-automation/admin';

export const workAutomationService = {
  // ---- employee ----
  syncMe: async () => (await axiosClient.post(`${BASE}/sync/me`)).data as { skipped?: string },
  syncMeNow: async () => (await axiosClient.post(`${BASE}/sync/me/force`)).data as { skipped?: string },
  myDay: async (date?: string) => (await axiosClient.get<WorkDay>(`${BASE}/me/today`, { params: { date } })).data,
  myActivity: async (date?: string) => (await axiosClient.get<WorkActivity[]>(`${BASE}/me/activity`, { params: { date } })).data,
  userDay: async (userId: string, date?: string) => (await axiosClient.get<WorkDay>(`${BASE}/users/${userId}/today`, { params: { date } })).data,
  act: async (taskId: string, action: WorkAction, note?: string) => (await axiosClient.post<WorkTask>(`${BASE}/tasks/${taskId}/${action}`, { note })).data,
  myReports: async (limit = 30) => (await axiosClient.get<EodListItem[]>(`${BASE}/eod/mine`, { params: { limit } })).data,
  teamReports: async (date?: string) => (await axiosClient.get<EodListItem[]>(`${BASE}/eod/team`, { params: { date } })).data,
  report: async (id: string) => (await axiosClient.get<EodReportDetail>(`${BASE}/eod/${id}`)).data,
  deliveries: async (id: string) => (await axiosClient.get<EodDeliveryRow[]>(`${BASE}/eod/${id}/deliveries`)).data,
  team: async (date?: string) => (await axiosClient.get<TeamDashboard>(`${BASE}/team`, { params: { date } })).data,

  // ---- admin ----
  getConfig: async () => (await axiosClient.get<ConfigResponse>(`${ADMIN}/config`)).data,
  updateConfig: async (patch: Partial<AutomationConfig>) => (await axiosClient.put<ConfigResponse>(`${ADMIN}/config`, patch)).data,
  syncStatus: async () => (await axiosClient.get<SyncStatus>(`${ADMIN}/sync-status`)).data,
  runSync: async () => (await axiosClient.post(`${ADMIN}/sync/run`)).data,
  runEod: async () => (await axiosClient.post<{ generated: number; delivered: number; skipped?: string }>(`${ADMIN}/eod/run`)).data,
  resend: async (reportId: string) => (await axiosClient.post<{ reset: number; sent: number }>(`${ADMIN}/eod/${reportId}/resend`)).data,
  identities: async (status?: IdentityRow['status']) => (await axiosClient.get<IdentityRow[]>(`${ADMIN}/identities`, { params: { status } })).data,
  linkIdentity: async (id: string, userId: string) => (await axiosClient.post(`${ADMIN}/identities/${id}/link`, { userId })).data,
  unlinkIdentity: async (id: string) => (await axiosClient.post(`${ADMIN}/identities/${id}/unlink`)).data,
  ignoreIdentity: async (id: string) => (await axiosClient.post(`${ADMIN}/identities/${id}/ignore`)).data,
  hierarchy: async () => (await axiosClient.get<HierarchyPerson[]>(`${ADMIN}/hierarchy`)).data,
  setManager: async (userId: string, managerId: string | null) => (await axiosClient.put(`${ADMIN}/hierarchy/${userId}`, { managerId })).data,
};
