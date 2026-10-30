import { axiosClient } from '@/api/axiosClient';

export interface ZohoPayrollOrgOption {
  organizationId: string;
  name: string;
}

export interface ZohoPayrollStatus {
  connected: boolean;
  needsSelection: boolean;
  organizationName?: string;
  orgs?: ZohoPayrollOrgOption[];
}

export interface ZohoPayrollAppStatus {
  configured: boolean;
  clientId?: string;
  clientSecretMasked?: string;
  dataCenters: Record<string, { label: string; accountsBaseUrl: string }>;
}

// Mirrors zohoBooksService.ts exactly — same "bring your own app" shape
// (region + optional accountsServerUrl for 'other'), but a fully separate
// credential/endpoint set (provider 'zohopayroll'), per the backend's own
// independence from both Zoho CRM and Zoho Books.
export const zohoPayrollService = {
  async getAppCredentialsStatus(): Promise<ZohoPayrollAppStatus> {
    const { data } = await axiosClient.get('/zohopayroll/app-credentials');
    return data;
  },

  async saveAppCredentials(payload: { clientId: string; clientSecret: string; region: string; accountsServerUrl?: string }): Promise<void> {
    await axiosClient.post('/zohopayroll/app-credentials', payload);
  },

  async getConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/zohopayroll/connect-url');
    return data.url;
  },

  async getStatus(): Promise<ZohoPayrollStatus> {
    const { data } = await axiosClient.get<ZohoPayrollStatus>('/zohopayroll/status');
    return data;
  },

  async selectOrganization(organizationId: string): Promise<void> {
    await axiosClient.post('/zohopayroll/select-organization', { organizationId });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/zohopayroll/disconnect');
  },
};
