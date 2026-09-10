import { adminAxiosClient } from '@/api/adminAxiosClient';
import type { CredentialStatus } from './integrationsService';

// Platform-level AI provider credentials (Anthropic, Sarvam) — same request/
// response shapes as integrationsService.ts's connectWithApiKey/
// getCredentialStatus/disconnectCredential (reusing the exact same backend
// IntegrationsService methods, see
// backend/src/integrations/admin-integrations.controller.ts), just routed
// through the admin session's own auth (adminAxiosClient) instead of the
// customer session's, since a platform admin has no organizationId to
// authenticate the customer-facing routes with. The backend always resolves
// these to organizationId="platform" server-side — the frontend never sends
// or controls that scope.
export type AiProvider = 'anthropic' | 'sarvam';

export const adminIntegrationsService = {
  async connect(provider: AiProvider, apiKey: string): Promise<CredentialStatus> {
    const { data } = await adminAxiosClient.post<CredentialStatus>(`/integrations/admin/${provider}/connect`, { apiKey });
    return data;
  },

  async getStatus(provider: AiProvider): Promise<CredentialStatus> {
    const { data } = await adminAxiosClient.get<CredentialStatus>(`/integrations/admin/${provider}/status`);
    return data;
  },

  async disconnect(provider: AiProvider): Promise<void> {
    await adminAxiosClient.delete(`/integrations/admin/${provider}`);
  },
};
