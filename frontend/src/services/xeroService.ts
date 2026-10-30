import { axiosClient } from '@/api/axiosClient';

export interface XeroTenantOption {
  tenantId: string;
  tenantName: string;
}

export interface XeroStatus {
  connected: boolean;
  needsSelection: boolean;
  tenantName?: string;
  tenants?: XeroTenantOption[];
}

// Mirrors crmIntegrationsService.ts's OAuth helpers (getOAuthConnectUrl etc.)
// — same shape, separate file since Xero is an Accounting connection, not a
// CRM one, with its own backend module (backend/src/xero/).
export const xeroService = {
  async getAppStatus(): Promise<{ configured: boolean }> {
    const { data } = await axiosClient.get('/xero/app-status');
    return data;
  },

  async getConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/xero/connect-url');
    return data.url;
  },

  async getStatus(): Promise<XeroStatus> {
    const { data } = await axiosClient.get<XeroStatus>('/xero/status');
    return data;
  },

  async selectTenant(tenantId: string): Promise<void> {
    await axiosClient.post('/xero/select-tenant', { tenantId });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/xero/disconnect');
  },
};
