import { axiosClient } from '@/api/axiosClient';

export interface MyobStatus {
  connected: boolean;
  needsCompanyFileCredentials: boolean;
}

// Mirrors xeroService.ts's shape, plus one route no other provider here
// needs: companyFileCredentials, for the second credential pair MYOB
// requires beyond OAuth (see backend/src/myob/myob.service.ts).
export const myobService = {
  async getAppStatus(): Promise<{ configured: boolean }> {
    const { data } = await axiosClient.get('/myob/app-status');
    return data;
  },

  async getConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/myob/connect-url');
    return data.url;
  },

  async getStatus(): Promise<MyobStatus> {
    const { data } = await axiosClient.get<MyobStatus>('/myob/status');
    return data;
  },

  async saveCompanyFileCredentials(username: string, password: string): Promise<void> {
    await axiosClient.post('/myob/company-file-credentials', { username, password });
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/myob/disconnect');
  },
};
