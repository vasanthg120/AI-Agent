import { adminAxiosClient } from '@/api/adminAxiosClient';

// Platform-wide Langfuse observability configuration — same shape as
// adminIntegrationsService.ts (routed through adminAxiosClient, resolved
// server-side to organizationId="platform", never sent/controlled from
// here), but its own dedicated backend module (backend/src/langfuse/)
// rather than the generic IntegrationCredential flow, since Langfuse's
// field set (public/secret key, base URL, environment, sampling rate,
// capture-input-output) doesn't fit that shape.
export interface LangfuseConfigStatus {
  enabled: boolean;
  publicKeyMasked: string | null;
  secretConfigured: boolean;
  baseUrl: string;
  environment: 'development' | 'staging' | 'production';
  samplingRate: number;
  captureInputOutput: boolean;
  connectionStatus: 'untested' | 'connected' | 'error';
  lastTestedAt: string | null;
  lastSuccessfulTraceAt: string | null;
  errorMessage: string | null;
}

export interface SaveLangfuseConfigPayload {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  environment?: 'development' | 'staging' | 'production';
  samplingRate?: number;
  captureInputOutput?: boolean;
}

export const langfuseService = {
  async getConfig(): Promise<LangfuseConfigStatus> {
    const { data } = await adminAxiosClient.get<LangfuseConfigStatus>('/langfuse/admin/config');
    return data;
  },

  async saveConfig(payload: SaveLangfuseConfigPayload): Promise<void> {
    await adminAxiosClient.post('/langfuse/admin/config', payload);
  },

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const { data } = await adminAxiosClient.post<{ ok: boolean; message: string }>('/langfuse/admin/test-connection');
    return data;
  },

  async setEnabled(enabled: boolean): Promise<void> {
    await adminAxiosClient.post('/langfuse/admin/enabled', { enabled });
  },
};
