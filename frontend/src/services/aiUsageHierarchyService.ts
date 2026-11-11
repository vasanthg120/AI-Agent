import { adminAxiosClient } from '@/api/adminAxiosClient';

// Provider-agnostic hierarchical AI usage analytics (Platform -> Organisation
// -> User -> Request -> Generation) — a separate, newer sibling to
// aiUsageAdminService.ts (which stays Anthropic-budget-tracking specific and
// untouched). Same adminAxiosClient routing (platform-admin session, server
// resolves organizationId="platform" where relevant — never sent/controlled
// from here).

export interface ProviderModelBreakdownRow {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface PlatformOverview {
  days: number;
  organizationCount: number;
  activeUserCount: number;
  requestCount: number;
  tokens: { input: number; output: number; total: number };
  providerCostUsd: number;
  customerChargeCredits: number;
  requests: { total: number; successful: number; failed: number };
  providerModelBreakdown: ProviderModelBreakdownRow[];
  dailySeries: { date: string; cost: number; requests: number }[];
}

export interface OrganizationListRow {
  organizationId: string;
  organizationName: string;
  status: string | null;
  createdAt: string | null;
  requests: number;
  activeUsers: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  customerChargeCredits: number;
}

export interface OrganizationUserRow {
  userId: string;
  userName: string;
  email: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  lastActivity: string | null;
}

export interface OrganizationDetail {
  organizationId: string;
  organizationName: string;
  status: string | null;
  days: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  customerChargeCredits: number;
  users: OrganizationUserRow[];
}

export interface UserRequestRow {
  requestId: string;
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  generationCount: number;
  status: 'success' | 'failed';
  agents: string[];
}

export interface UserDetail {
  organizationId: string;
  userId: string;
  userName: string;
  email: string | null;
  days: number;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  customerChargeCredits: number;
  lastActivity: string | null;
  modelBreakdown: { model: string; requests: number; cost: number }[];
  agentBreakdown: { agentName: string; requests: number; cost: number }[];
  requests: { items: UserRequestRow[]; total: number; page: number; pageSize: number };
}

export interface RequestGeneration {
  id: string;
  kind: 'llm' | 'tool';
  agentName: string;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  success: boolean;
  error: string | null;
  occurredAt: string;
  langfuseTraceUrl: string | null;
}

export interface RequestDetail {
  requestId: string;
  organizationId: string | null;
  userId: string | null;
  conversationId: string | null;
  startedAt: string | null;
  status: 'success' | 'failed' | null;
  summary: {
    generationCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number | null;
    providerCostUsd: number;
    customerChargeCredits: number;
  };
  generations: RequestGeneration[];
}

export const aiUsageHierarchyService = {
  async getOverview(days: number): Promise<PlatformOverview> {
    const { data } = await adminAxiosClient.get<PlatformOverview>('/ai-usage/admin/overview', { params: { days } });
    return data;
  },

  async getOrganizations(days: number, search?: string): Promise<OrganizationListRow[]> {
    const { data } = await adminAxiosClient.get<OrganizationListRow[]>('/ai-usage/admin/organizations', { params: { days, search } });
    return data;
  },

  async getOrganizationDetail(organizationId: string, days: number): Promise<OrganizationDetail> {
    const { data } = await adminAxiosClient.get<OrganizationDetail>(`/ai-usage/admin/organizations/${organizationId}`, { params: { days } });
    return data;
  },

  async getUserDetail(organizationId: string, userId: string, days: number, page: number, pageSize: number): Promise<UserDetail> {
    const { data } = await adminAxiosClient.get<UserDetail>(`/ai-usage/admin/organizations/${organizationId}/users/${userId}`, {
      params: { days, page, pageSize },
    });
    return data;
  },

  async getRequestDetail(organizationId: string, userId: string, requestId: string): Promise<RequestDetail> {
    const { data } = await adminAxiosClient.get<RequestDetail>(`/ai-usage/admin/organizations/${organizationId}/users/${userId}/requests/${requestId}`);
    return data;
  },

  // Same authenticated blob-download pattern as billingAdminService's own
  // invoice export (adminAxiosClient carries the admin session's auth
  // header; a plain <a href> URL wouldn't).
  async exportCsv(scope: { organizationId?: string; userId?: string }, days: number): Promise<Blob> {
    const { data } = await adminAxiosClient.get(`/ai-usage/admin/export`, {
      params: { days, organizationId: scope.organizationId, userId: scope.userId },
      responseType: 'blob',
    });
    return data;
  },
};
