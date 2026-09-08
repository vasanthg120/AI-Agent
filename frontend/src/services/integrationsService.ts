import { axiosClient } from '@/api/axiosClient';

export interface CredentialStatus {
  connected: boolean;
  maskedKey?: string;
  baseUrl?: string;
}

export interface OutlookAccount {
  email: string;
  isActive: boolean;
  connectedAt: string;
  // 'needs_reauth' — python-agent's refresh loop found the grant revoked/
  // expired (see outlook_store.py/gmail_store.py's _refresh) and no amount
  // of retrying fixes it; the UI should prompt to reconnect.
  status: 'connected' | 'needs_reauth';
}

export type GmailAccount = OutlookAccount;

export interface OutlookOrgAccount extends OutlookAccount {
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
}

export interface TenantAuthorizationStatus {
  authorized: boolean;
  tenantId?: string;
  authorizedByEmail?: string;
}

// Mirrors backend/src/integrations/auth-methods.ts's AuthType exactly.
// OAuth-based platforms (Salesforce, Slack, HubSpot, ...) aren't included —
// those need their own dedicated consent flow, not a credentials form.
export type AuthType = 'apiKey' | 'apiKeyBaseUrl' | 'bearer' | 'basic' | 'customHeaders';

export interface AuthCredentials {
  apiKey?: string;
  headerName?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

export interface CustomIntegration {
  provider: string;
  // Customer-facing name — never the raw provider slug for a white-labeled
  // provider (e.g. the underlying CRM vendor); use this for display, keep
  // `provider` only as the internal key for API calls.
  label: string;
  connected: boolean;
  authType?: AuthType;
  maskedKey?: string;
  baseUrl?: string;
  connectedAt?: string;
}

export interface ConnectCustomIntegrationPayload {
  authType: AuthType;
  credentials: AuthCredentials;
  baseUrl?: string;
  healthCheckPath?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

// Mirrors backend/src/integrations/provider-rules.ts's ProviderRule.
export interface ProviderRule {
  label: string;
  allowedAuthTypes: AuthType[];
  dedicatedFlowPath?: string;
  note?: string;
}

// API Integration Engine — one integration -> unlimited resources ->
// unlimited endpoints, each an arbitrary REST action run through the
// backend's one generic Dynamic Executor (see backend/src/integrations/
// dynamic-executor.service.ts). Mirrors integration-resource.schema.ts /
// integration-endpoint.schema.ts.
export interface IntegrationResource {
  _id: string;
  key: string;
  name: string;
  description?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointQueryParam {
  name: string;
  required?: boolean;
  description?: string;
}

export interface EndpointStaticHeader {
  name: string;
  value: string;
}

export interface IntegrationEndpoint {
  _id: string;
  key: string;
  name: string;
  method: HttpMethod;
  path: string;
  queryParams?: EndpointQueryParam[];
  headers?: EndpointStaticHeader[];
  requestBodySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  description?: string;
}

export interface CreateResourcePayload {
  name: string;
  key: string;
  description?: string;
}

export interface CreateEndpointPayload {
  name: string;
  key: string;
  method: HttpMethod;
  path: string;
  queryParams?: EndpointQueryParam[];
  headers?: EndpointStaticHeader[];
  requestBodySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
  description?: string;
}

export interface EndpointTestResult {
  ok: boolean;
  message: string;
  statusCode?: number;
  data?: unknown;
}

// Bulk connector import — pastes a whole connector manifest (base URL + an
// auth template + modules[].actions[]) and the backend creates the
// credential plus every resource/endpoint in one call. Mirrors backend/src/
// integrations/dto/import-connector-manifest.dto.ts field-for-field so a
// real connector spec (like ProspectConnect's) can be pasted with no
// reshaping. The manifest itself never carries a live secret — see
// ImportConnectorManifestSecrets below.
export interface ManifestAction {
  name: string;
  method: HttpMethod;
  path: string;
  description?: string;
}

export interface ManifestModule {
  module: string;
  actions: ManifestAction[];
}

export interface ManifestAuth {
  type?: string;
  location?: string;
  header_name?: string;
  value_template?: string;
  note?: string;
}

export interface ConnectorManifest {
  connector_id: string;
  display_name?: string;
  version?: string;
  base_url: string;
  auth: ManifestAuth;
  test_connection_action?: string;
  modules: ManifestModule[];
}

// Supplied separately from the pasted manifest — never embedded in it, so a
// manifest stays safe to copy/paste/share.
export interface ImportConnectorManifestSecrets {
  apiKeyValue?: string;
  username?: string;
  password?: string;
}

export interface ImportConnectorManifestResult {
  provider: string;
  authType: AuthType;
  resourcesCreated: number;
  endpointsCreated: number;
}

const BEARER_TEMPLATE = /^Bearer\s*\{\{\s*api_key\s*\}\}$/i;
const BARE_TOKEN_TEMPLATE = /^\{\{\s*api_key\s*\}\}$/i;

// Client-side mirror of backend/src/integrations/connector-manifest.util.ts's
// resolveManifestAuthType — used only for the Import Connector modal's live
// "Detected auth type" preview, so the right credential input shows before
// the user submits. The backend re-derives this itself on import and is the
// actual authority; if the two ever disagree, the backend's result wins.
export function resolveManifestAuthType(auth: ManifestAuth): AuthType {
  if (auth.type === 'basic') return 'basic';
  const headerName = (auth.header_name || 'Authorization').trim();
  const template = (auth.value_template || '{{api_key}}').trim();
  if (headerName.toLowerCase() === 'authorization' && BEARER_TEMPLATE.test(template)) return 'bearer';
  if (headerName.toLowerCase() !== 'authorization' && BARE_TOKEN_TEMPLATE.test(template)) return 'apiKey';
  return 'customHeaders';
}

export const integrationsService = {
  // Generic API-key-backed integrations (Anthropic, CRM) — backed by the
  // NestJS /integrations module, which stores the credential in Mongo for
  // python-agent to read at call time (see backend/src/integrations).
  async connectWithApiKey(provider: string, apiKey: string, baseUrl?: string): Promise<CredentialStatus> {
    const { data } = await axiosClient.post<CredentialStatus>(`/integrations/${provider}/connect`, {
      apiKey,
      baseUrl,
    });
    return data;
  },

  async getCredentialStatus(provider: string): Promise<CredentialStatus> {
    const { data } = await axiosClient.get<CredentialStatus>(`/integrations/${provider}/status`);
    return data;
  },

  async disconnectCredential(provider: string): Promise<void> {
    await axiosClient.delete(`/integrations/${provider}`);
  },

  // "Smart provider detection" — call as the user types a provider name in
  // the Add Integration wizard, to show only auth methods that provider
  // actually supports (unknown names get every non-OAuth method — the
  // generic Custom REST API case).
  async getProviderRule(provider: string): Promise<ProviderRule> {
    const { data } = await axiosClient.get<ProviderRule>(`/integrations/provider-rules/${provider}`);
    return data;
  },

  // Generic "connect any CRM/SaaS" flow — any auth type from AuthType above,
  // for a provider name the user types in themselves (not one of the fixed
  // Anthropic/CRM/Outlook/Gmail cards). Backed by the same /integrations
  // endpoints as connectWithApiKey above; the backend routes on whether the
  // body sets authType (see IntegrationsService.connectFromDto).
  async listCustomIntegrations(): Promise<CustomIntegration[]> {
    const { data } = await axiosClient.get<CustomIntegration[]>('/integrations');
    return data;
  },

  async connectCustomIntegration(provider: string, payload: ConnectCustomIntegrationPayload): Promise<void> {
    await axiosClient.post(`/integrations/${provider}/connect`, payload);
  },

  // Body omitted (or partial) re-tests whatever's already saved; a full
  // payload tests it before saving, from the connect wizard.
  async testCustomIntegrationConnection(
    provider: string,
    payload?: Partial<ConnectCustomIntegrationPayload>,
  ): Promise<TestConnectionResult> {
    const { data } = await axiosClient.post<TestConnectionResult>(`/integrations/${provider}/test`, payload ?? {});
    return data;
  },

  // Outlook has its own dedicated OAuth module on the backend (real
  // Microsoft Graph delegated auth-code flow, already configured).
  async getOutlookStatus(): Promise<{ connected: boolean; email?: string; canSend: boolean }> {
    const { data } = await axiosClient.get<{ connected: boolean; email?: string; canSend: boolean }>('/outlook/status');
    return data;
  },

  async getOutlookConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/outlook/connect-url');
    return data.url;
  },

  async getOutlookAccounts(): Promise<OutlookAccount[]> {
    const { data } = await axiosClient.get<OutlookAccount[]>('/outlook/accounts');
    return data;
  },

  async setActiveOutlookAccount(email: string): Promise<void> {
    await axiosClient.post(`/outlook/accounts/${encodeURIComponent(email)}/activate`);
  },

  async disconnectOutlookAccount(email: string): Promise<void> {
    await axiosClient.delete(`/outlook/accounts/${encodeURIComponent(email)}`);
  },

  // Org-wide view (every teammate's connected mailbox — sales@, support@,
  // hr@ — not just the caller's own). Read-only for any org member;
  // connect/disconnect stays scoped to each account's own owner above.
  async getOutlookOrgAccounts(): Promise<OutlookOrgAccount[]> {
    const { data } = await axiosClient.get<OutlookOrgAccount[]>('/outlook/org-accounts');
    return data;
  },

  // Tenant-wide admin consent — a separate Microsoft flow from connect-url
  // above; a tenant admin visits the returned URL once so every employee's
  // regular Connect click stops hitting Microsoft's "Need admin approval"
  // wall (see backend/src/outlook/outlook.service.ts's buildAdminConsentUrl).
  async getOutlookAdminConsentUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/outlook/admin-consent-url');
    return data.url;
  },

  async getOutlookTenantAuthorizationStatus(): Promise<TenantAuthorizationStatus> {
    const { data } = await axiosClient.get<TenantAuthorizationStatus>('/outlook/tenant-authorization-status');
    return data;
  },

  // Gmail mirrors Outlook's OAuth shape exactly (real Google OAuth
  // delegated auth-code flow) — see backend/src/gmail.
  async getGmailConnectUrl(): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>('/gmail/connect-url');
    return data.url;
  },

  async getGmailAccounts(): Promise<GmailAccount[]> {
    const { data } = await axiosClient.get<GmailAccount[]>('/gmail/accounts');
    return data;
  },

  async setActiveGmailAccount(email: string): Promise<void> {
    await axiosClient.post(`/gmail/accounts/${encodeURIComponent(email)}/activate`);
  },

  async disconnectGmailAccount(email: string): Promise<void> {
    await axiosClient.delete(`/gmail/accounts/${encodeURIComponent(email)}`);
  },

  // API Integration Engine — resource/endpoint CRUD (admin) + the generic
  // execute route (any authenticated user) backed by resources.controller.ts.
  async listResources(provider: string): Promise<IntegrationResource[]> {
    const { data } = await axiosClient.get<IntegrationResource[]>(`/integrations/${provider}/resources`);
    return data;
  },

  async createResource(provider: string, payload: CreateResourcePayload): Promise<IntegrationResource> {
    const { data } = await axiosClient.post<IntegrationResource>(`/integrations/${provider}/resources`, payload);
    return data;
  },

  async deleteResource(provider: string, resourceKey: string): Promise<void> {
    await axiosClient.delete(`/integrations/${provider}/resources/${encodeURIComponent(resourceKey)}`);
  },

  async listEndpoints(provider: string, resourceKey: string): Promise<IntegrationEndpoint[]> {
    const { data } = await axiosClient.get<IntegrationEndpoint[]>(
      `/integrations/${provider}/resources/${encodeURIComponent(resourceKey)}/endpoints`,
    );
    return data;
  },

  async createEndpoint(
    provider: string,
    resourceKey: string,
    payload: CreateEndpointPayload,
  ): Promise<IntegrationEndpoint> {
    const { data } = await axiosClient.post<IntegrationEndpoint>(
      `/integrations/${provider}/resources/${encodeURIComponent(resourceKey)}/endpoints`,
      payload,
    );
    return data;
  },

  async deleteEndpoint(provider: string, resourceKey: string, endpointKey: string): Promise<void> {
    await axiosClient.delete(
      `/integrations/${provider}/resources/${encodeURIComponent(resourceKey)}/endpoints/${encodeURIComponent(endpointKey)}`,
    );
  },

  async testEndpoint(
    provider: string,
    resourceKey: string,
    endpointKey: string,
    payload: { pathParams?: Record<string, string>; query?: Record<string, string>; body?: unknown },
  ): Promise<EndpointTestResult> {
    const { data } = await axiosClient.post<EndpointTestResult>(
      `/integrations/${provider}/resources/${encodeURIComponent(resourceKey)}/endpoints/${encodeURIComponent(endpointKey)}/test`,
      payload,
    );
    return data;
  },

  async importConnectorManifest(
    manifest: ConnectorManifest,
    secrets: ImportConnectorManifestSecrets,
  ): Promise<ImportConnectorManifestResult> {
    const { data } = await axiosClient.post<ImportConnectorManifestResult>('/integrations/import-connector', {
      ...manifest,
      ...secrets,
    });
    return data;
  },
};
