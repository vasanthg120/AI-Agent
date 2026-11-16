import { axiosClient } from '@/api/axiosClient';

export interface SquareStatus {
  connected: boolean;
  environment?: 'sandbox' | 'production';
  applicationId?: string;
  merchantId?: string;
  businessName?: string;
  country?: string;
  currency?: string;
  countrySupported?: boolean;
  needsReauth?: boolean;
}

export interface SquarePayment {
  id: string;
  status: string;
  amount_money?: { amount: number; currency: string };
  created_at?: string;
  [key: string]: unknown;
}

// Primary connect path, the only one surfaced in the UI: a directly-pasted
// Application ID + Personal Access Token (for an org's own account —
// connect()/testConnection() below, no redirect). The backend also still
// supports OAuth via this org's own saved Square Developer app (for a
// DIFFERENT merchant account — saveAppCredentials()/getConnectUrl() below,
// same shape as xeroService.ts/zohoService.ts), kept working but no longer
// shown in the simplified connect form.
export const squareService = {
  async connect(applicationId: string, accessToken: string, environment: 'sandbox' | 'production'): Promise<SquareStatus> {
    const { data } = await axiosClient.post<SquareStatus>('/square/connect', { applicationId, accessToken, environment });
    return data;
  },

  async testConnection(accessToken: string, environment: 'sandbox' | 'production'): Promise<{ ok: boolean; message: string }> {
    const { data } = await axiosClient.post('/square/test-connection', { accessToken, environment });
    return data;
  },

  async saveAppCredentials(applicationId: string, applicationSecret: string): Promise<{ configured: true }> {
    const { data } = await axiosClient.post('/square/app-credentials', { applicationId, applicationSecret });
    return data;
  },

  async getAppCredentialsStatus(): Promise<{ configured: boolean; clientId?: string }> {
    const { data } = await axiosClient.get('/square/app-credentials');
    return data;
  },

  async getConnectUrl(environment: 'sandbox' | 'production'): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/square/connect-url', { params: { environment } });
    return data.url;
  },

  async getStatus(): Promise<SquareStatus> {
    const { data } = await axiosClient.get<SquareStatus>('/square/status');
    return data;
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/square/disconnect');
  },

  async listPayments(params: { beginTime?: string; endTime?: string; cursor?: string } = {}): Promise<{ payments: SquarePayment[]; cursor?: string }> {
    const { data } = await axiosClient.get('/square/payments', { params });
    return data;
  },

  async getPayment(paymentId: string): Promise<SquarePayment> {
    const { data } = await axiosClient.get(`/square/payments/${paymentId}`);
    return data;
  },

  async createPayment(payload: {
    sourceId: string;
    amount: number;
    currency: string;
    idempotencyKey?: string;
    customerId?: string;
    orderId?: string;
    referenceId?: string;
    note?: string;
  }): Promise<SquarePayment> {
    const { data } = await axiosClient.post('/square/payments', payload);
    return data;
  },
};
