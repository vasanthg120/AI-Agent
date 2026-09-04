import { axiosClient } from '@/api/axiosClient';
import type { EmailIntelligenceItem } from './emailIntelligenceService';

// Covers both Business Intelligence sections 1 (Sent) and 2 (Missed) — the
// backend combines them behind one email-analytics.controller.ts (kind:
// 'sent' | 'missed' throughout), so a single service file matches the real
// API shape rather than splitting into two files that would both just wrap
// the same endpoints with a different `kind`.

export interface BiFilters {
  dateFrom?: string;
  dateTo?: string;
  employeeId?: string[];
  storeId?: string[];
}

export interface EmailActivitySummary {
  totalRelevantCount: number;
  sentCount: number;
  repliedCount: number;
  missedCount: number;
  newEnquiryCount: number;
  byIntent: { intent: string; label: string; receivedCount: number; sentCount: number }[];
}

export interface EmployeeEmailAnalyticsRow {
  userId: string;
  userName: string;
  count: number;
  byPriority?: { value: string; count: number }[];
  byUrgency?: { value: string; count: number }[];
  ageBuckets?: { bucket: string; count: number }[];
}

export interface ListBiEmailsResult {
  items: EmailIntelligenceItem[];
  total: number;
  page: number;
  pageSize: number;
}

function toParams(filters: BiFilters, extra?: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...extra };
  if (filters.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters.dateTo) params.dateTo = filters.dateTo;
  if (filters.employeeId?.length) params.employeeId = filters.employeeId.join(',');
  if (filters.storeId?.length) params.storeId = filters.storeId.join(',');
  return params;
}

export const emailAnalyticsService = {
  async getSummary(filters: BiFilters): Promise<EmailActivitySummary> {
    const { data } = await axiosClient.get<EmailActivitySummary>('/business-intelligence/email-analytics/summary', {
      params: toParams(filters),
    });
    return data;
  },

  async getByEmployee(
    kind: 'sent' | 'missed' | 'replied',
    filters: BiFilters,
  ): Promise<{ rows: EmployeeEmailAnalyticsRow[]; totalCount: number }> {
    const { data } = await axiosClient.get<{ rows: EmployeeEmailAnalyticsRow[]; totalCount: number }>(
      '/business-intelligence/email-analytics/by-employee',
      { params: toParams(filters, { kind }) },
    );
    return data;
  },

  async listEmails(
    kind: 'sent' | 'missed' | 'replied' | 'all',
    filters: BiFilters,
    page: number,
    pageSize: number,
    intent?: string,
  ): Promise<ListBiEmailsResult> {
    const { data } = await axiosClient.get<ListBiEmailsResult>('/business-intelligence/email-analytics/emails', {
      params: toParams(filters, { kind, page, pageSize, intent }),
    });
    return data;
  },

  async getOne(id: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.get<EmailIntelligenceItem>(`/business-intelligence/email-analytics/emails/${id}`);
    return data;
  },

  // Full body, fetched live from Outlook (never stored — see
  // EmailIntelligenceItem.bodyPreview's own short-snippet-only comment) so
  // "open and read" shows the real email rather than a ~255-char preview.
  async getBody(id: string): Promise<{ contentType: string; content: string }> {
    const { data } = await axiosClient.get<{ contentType: string; content: string }>(
      `/business-intelligence/email-analytics/emails/${id}/body`,
    );
    return data;
  },

  async downloadExport(kind: 'sent' | 'missed' | 'all', filters: BiFilters, format: 'csv' | 'xlsx' | 'pdf'): Promise<void> {
    const response = await axiosClient.get('/business-intelligence/email-analytics/export', {
      params: toParams(filters, { kind, format }),
      responseType: 'blob',
    });
    const disposition = response.headers['content-disposition'] as string | undefined;
    const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `emails.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
