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
export type AiProvider = 'anthropic' | 'sarvam' | 'elevenlabs' | 'groq';

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

  // Distinct from getStatus() above — that's a DB-existence check
  // ("Configured"); this makes one real, minimal call through python-agent
  // using the already-connected key ("Verified").
  async verify(provider: AiProvider): Promise<{ ok: boolean; message: string }> {
    const { data } = await adminAxiosClient.post<{ ok: boolean; message: string }>(`/integrations/admin/${provider}/verify`);
    return data;
  },

  // Gmail's own Google OAuth app (Client ID/Secret) — a different shape
  // from the AI providers above (no apiKey, no /verify ping; see
  // backend/src/integrations/admin-integrations.controller.ts's own comment
  // on why). One platform-wide app for every organization's Gmail
  // mailboxes — ordinary customer users never see this, only reach the
  // read-only integrationsService.getGmailAppStatus() boolean check.
  async getGmailAppCredentialsStatus(): Promise<{ configured: boolean; clientId?: string; clientSecretMasked?: string }> {
    const { data } = await adminAxiosClient.get('/integrations/admin/gmail/app-credentials');
    return data;
  },

  async saveGmailAppCredentials(payload: { clientId: string; clientSecret: string }): Promise<void> {
    await adminAxiosClient.post('/integrations/admin/gmail/app-credentials', payload);
  },
};
