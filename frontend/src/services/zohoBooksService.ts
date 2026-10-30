import { axiosClient } from '@/api/axiosClient';

export interface ZohoBooksOrgOption {
  organizationId: string;
  name: string;
}

export interface ZohoBooksStatus {
  connected: boolean;
  needsSelection: boolean;
  organizationName?: string;
  orgs?: ZohoBooksOrgOption[];
}

export interface ZohoBooksAppStatus {
  configured: boolean;
  clientId?: string;
  clientSecretMasked?: string;
  dataCenters: Record<string, { label: string; accountsBaseUrl: string }>;
}

// Mirrors crmIntegrationsService.ts's Zoho CRM "bring your own app" helpers
// — same shape (region + optional accountsServerUrl for 'other'), but a
// fully separate credential/endpoint set (provider 'zohobooks'), per the
// backend's own independence from the Zoho CRM integration.
export const zohoBooksService = {
  async getAppCredentialsStatus(): Promise<ZohoBooksAppStatus> {
    const { data } = await axiosClient.get('/zohobooks/app-credentials');
    return data;
  },

  async saveAppCredentials(payload: { clientId: string; clientSecret: string; region: string; accountsServerUrl?: string }): Promise<void> {
    await axiosClient.post('/zohobooks/app-credentials', payload);
  },

  async getConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/zohobooks/connect-url');
    return data.url;
  },

  async getStatus(): Promise<ZohoBooksStatus> {
    const { data } = await axiosClient.get<ZohoBooksStatus>('/zohobooks/status');
    return data;
  },

  async selectOrganization(organizationId: string): Promise<void> {
    await axiosClient.post('/zohobooks/select-organization', { organizationId });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/zohobooks/disconnect');
  },
};
