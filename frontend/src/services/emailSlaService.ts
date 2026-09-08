import { axiosClient } from '@/api/axiosClient';

export const EMAIL_SLA_STATUSES = ['PENDING', 'IN_PROGRESS', 'RESPONDED', 'BREACHED', 'ESCALATED', 'EXCLUDED'] as const;
export type EmailSlaStatus = (typeof EMAIL_SLA_STATUSES)[number];

export interface EmailSlaRecord {
  _id: string;
  organizationId: string;
  emailId: string;
  conversationId?: string;
  assignedUserId: string;
  receivedAt: string;
  slaStartedAt: string;
  slaDueAt: string;
  firstResponseAt?: string;
  responseTimeSeconds?: number;
  status: EmailSlaStatus;
  priority: string;
  isBreached: boolean;
  breachedAt?: string;
  escalatedAt?: string;
  escalationLevel: number;
  businessHoursApplied: boolean;
  excludedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailSlaEvent {
  _id: string;
  organizationId: string;
  recordId: string;
  type: 'created' | 'responded' | 'breached' | 'escalated' | 'resolved' | 'excluded';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EmailSlaDashboard {
  totalEligible: number;
  respondedWithinSla: number;
  compliancePct: number | null;
  breached: number;
  openOverdue: number;
  escalated: number;
  avgResponseSeconds: number | null;
  medianResponseSeconds: number | null;
  byPriority: { priority: string; total: number; breached: number; avgResponseSeconds: number | null }[];
  byEmployee: { assignedUserId: string; total: number; breached: number }[];
}

export interface EmailSlaPolicy {
  _id: string;
  organizationId: string;
  priority: string;
  firstResponseTimeMinutes: number;
  businessHoursEnabled: boolean;
  enabled: boolean;
}

export interface UpsertSlaPolicyPayload {
  priority: string;
  firstResponseTimeMinutes: number;
  businessHoursEnabled?: boolean;
  enabled?: boolean;
}

export interface BusinessHoursConfig {
  _id: string;
  organizationId: string;
  timezone: string;
  workingDays: number[];
  workingStartTime: string;
  workingEndTime: string;
  holidays: string[];
}

export interface UpdateBusinessHoursPayload {
  timezone?: string;
  workingDays?: number[];
  workingStartTime?: string;
  workingEndTime?: string;
  holidays?: string[];
}

export interface EmailEscalationRule {
  _id: string;
  organizationId: string;
  priority: string;
  escalationLevel: number;
  delayMinutes: number;
  notifyAssignedUser: boolean;
  notifyManager: boolean;
  notifyAdmin: boolean;
  enabled: boolean;
}

export interface UpsertEscalationRulePayload {
  priority: string;
  escalationLevel: number;
  delayMinutes: number;
  notifyAssignedUser?: boolean;
  notifyManager?: boolean;
  notifyAdmin?: boolean;
  enabled?: boolean;
}

// Mirrors backend/src/email-sla/email-sla.controller.ts route-for-route.
// Isolated from emailIntelligenceService — the SLA module is its own
// additive extension, not a rename/merge of the existing service.
export const emailSlaService = {
  async listRecords(status?: EmailSlaStatus, assignedUserId?: string): Promise<EmailSlaRecord[]> {
    const { data } = await axiosClient.get<EmailSlaRecord[]>('/email-sla/records', {
      params: { ...(status ? { status } : {}), ...(assignedUserId ? { assignedUserId } : {}) },
    });
    return data;
  },

  async getRecord(id: string): Promise<EmailSlaRecord> {
    const { data } = await axiosClient.get<EmailSlaRecord>(`/email-sla/records/${id}`);
    return data;
  },

  async resolveRecord(id: string): Promise<EmailSlaRecord> {
    const { data } = await axiosClient.post<EmailSlaRecord>(`/email-sla/records/${id}/resolve`);
    return data;
  },

  async excludeRecord(id: string, reason?: string): Promise<EmailSlaRecord> {
    const { data } = await axiosClient.post<EmailSlaRecord>(`/email-sla/records/${id}/exclude`, { reason });
    return data;
  },

  async getDashboard(): Promise<EmailSlaDashboard> {
    const { data } = await axiosClient.get<EmailSlaDashboard>('/email-sla/dashboard');
    return data;
  },

  async listEvents(recordId?: string): Promise<EmailSlaEvent[]> {
    const { data } = await axiosClient.get<EmailSlaEvent[]>('/email-sla/events', { params: recordId ? { recordId } : {} });
    return data;
  },

  async listPolicies(): Promise<EmailSlaPolicy[]> {
    const { data } = await axiosClient.get<EmailSlaPolicy[]>('/email-sla/policies');
    return data;
  },

  async upsertPolicy(payload: UpsertSlaPolicyPayload): Promise<EmailSlaPolicy> {
    const { data } = await axiosClient.post<EmailSlaPolicy>('/email-sla/policies', payload);
    return data;
  },

  async getBusinessHours(): Promise<BusinessHoursConfig> {
    const { data } = await axiosClient.get<BusinessHoursConfig>('/email-sla/business-hours');
    return data;
  },

  async upsertBusinessHours(payload: UpdateBusinessHoursPayload): Promise<BusinessHoursConfig> {
    const { data } = await axiosClient.post<BusinessHoursConfig>('/email-sla/business-hours', payload);
    return data;
  },

  async listEscalationRules(): Promise<EmailEscalationRule[]> {
    const { data } = await axiosClient.get<EmailEscalationRule[]>('/email-sla/escalations');
    return data;
  },

  async upsertEscalationRule(payload: UpsertEscalationRulePayload): Promise<EmailEscalationRule> {
    const { data } = await axiosClient.post<EmailEscalationRule>('/email-sla/escalations', payload);
    return data;
  },
};
