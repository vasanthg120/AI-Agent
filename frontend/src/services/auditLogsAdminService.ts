import { adminAxiosClient } from '@/api/adminAxiosClient';

// Platform-wide audit read — backend/src/audit/audit.controller.ts's
// GET /audit-logs/all (@Roles('platform_admin'), separate from the org-scoped
// GET /audit-logs regular org admins use). Entries are written automatically
// by the global AuditInterceptor for every mutating route app-wide — nothing
// on this page ever writes a log entry itself.
export interface AuditLogRow {
  _id: string;
  userId: string;
  organizationId?: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  ip?: string;
  createdAt: string;
}

export interface PagedAuditLogs {
  items: AuditLogRow[];
  total: number;
  page: number;
  limit: number;
}

export const auditLogsAdminService = {
  async listAll(params?: { userId?: string; route?: string; page?: number; limit?: number }): Promise<PagedAuditLogs> {
    const { data } = await adminAxiosClient.get<PagedAuditLogs>('/audit-logs/all', { params });
    return data;
  },
};
