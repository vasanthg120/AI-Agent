import { adminAxiosClient } from '@/api/adminAxiosClient';

export type GatewayProvider = 'razorpay' | 'stripe' | 'cashfree';
export type GatewayMode = 'live' | 'test';

export interface GatewayConfigStatus {
  provider: GatewayProvider;
  mode: GatewayMode;
  configured: boolean;
  isActive: boolean;
  maskedKeyId?: string;
  updatedAt?: string;
}

// Gateway credentials are only ever accepted here, encrypted immediately
// server-side (backend/src/billing/billing-admin-gateways.service.ts), and
// never returned decrypted — this file never stores a raw secret in
// component state beyond the single form submission that sends it.
export const billingGatewaysAdminService = {
  async list(): Promise<GatewayConfigStatus[]> {
    const { data } = await adminAxiosClient.get<GatewayConfigStatus[]>('/billing/admin/gateways');
    return data;
  },

  async upsert(provider: GatewayProvider, mode: GatewayMode, credentials: Record<string, string>): Promise<GatewayConfigStatus> {
    const { data } = await adminAxiosClient.post<GatewayConfigStatus>('/billing/admin/gateways', { provider, mode, credentials });
    return data;
  },

  async setActive(provider: GatewayProvider, mode: GatewayMode, active: boolean): Promise<GatewayConfigStatus> {
    const { data } = await adminAxiosClient.post<GatewayConfigStatus>(`/billing/admin/gateways/${provider}/${mode}/${active ? 'activate' : 'deactivate'}`);
    return data;
  },
};
