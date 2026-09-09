import { adminAxiosClient } from '@/api/adminAxiosClient';
import type { CredentialStatus } from './integrationsService';

// Platform-level Anthropic credential — same request/response shapes as
// integrationsService.ts's connectWithApiKey/getCredentialStatus/
// disconnectCredential (reusing the exact same backend IntegrationsService
// methods, see backend/src/integrations/admin-integrations.controller.ts),
// just routed through the admin session's own auth (adminAxiosClient)
// instead of the customer session's, since a platform admin has no
// organizationId to authenticate the customer-facing routes with.
export const adminIntegrationsService = {
  async connectAnthropic(apiKey: string): Promise<CredentialStatus> {
    const { data } = await adminAxiosClient.post<CredentialStatus>('/integrations/admin/anthropic/connect', { apiKey });
    return data;
  },

  async getAnthropicStatus(): Promise<CredentialStatus> {
    const { data } = await adminAxiosClient.get<CredentialStatus>('/integrations/admin/anthropic/status');
    return data;
  },

  async disconnectAnthropic(): Promise<void> {
    await adminAxiosClient.delete('/integrations/admin/anthropic');
  },
};
